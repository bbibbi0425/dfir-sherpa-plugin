// Windows UI Automation adapter. No private LM Studio API or conversation-file writes.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using SherpaNativeUia;
using System.Windows.Forms;

class SherpaBatchUi {
  static JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 2000000 };
  static IUIAutomation2 Automation;
  static IUIAutomationElement Root;
  static IUIAutomationElement[] Controls;
  static bool UsedAccessibleRoot;
  // UIA identifiers from the Windows SDK.
  const int Button=50000,Edit=50004,Text=50020,CheckBox=50002,ComboBox=50003;
  static IntPtr Window;
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr handle);
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr handle,int command);
  delegate bool WindowCallback(IntPtr window,IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent,WindowCallback callback,IntPtr data);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder name,int size);
  [DllImport("oleacc.dll",PreserveSig=false)]
  static extern void AccessibleObjectFromWindow(IntPtr window,uint objectId,ref Guid iid,
    [MarshalAs(UnmanagedType.Interface)] out IAccessible accessible);
  static string S(Dictionary<string,object> input,string key) {return input.ContainsKey(key) ? Convert.ToString(input[key]) : "";}
  static void Stage(string value) {Console.Error.WriteLine("UI stage: "+value);Console.Error.Flush();}
  static void RefreshControls() {
    Stage("reading LM Studio controls");
    var request=Automation.CreateCacheRequest();
    foreach(int property in new[]{30003,30005,30022,30001})request.AddProperty(property);
    // Use the native Windows UIA client rather than the legacy .NET UIA bridge.
    var found=Root.FindAllBuildCache(TreeScope.TreeScope_Descendants,Automation.ControlViewCondition,request);
    if(found.Length>5000)throw new Exception("LM Studio UI contains too many controls. Close extra chat panes.");
    var controls=new List<IUIAutomationElement>();
    for(int i=0;i<found.Length;i++)controls.Add(found.GetElement(i));
    Controls=controls.ToArray();
    Stage("controls loaded: "+Controls.Length+", visible: "+Controls.Count(e=>e.CachedIsOffscreen==0));
    if(!UsedAccessibleRoot && !Controls.Any(e=>e.CachedName=="Chat input")) {
      UsedAccessibleRoot=true;Stage("connecting to Chromium accessibility document");
      var renderers=new List<IntPtr>();
      EnumChildWindows(Window,(handle,data)=>{
        var name=new StringBuilder(256);GetClassName(handle,name,name.Capacity);
        if(name.ToString()=="Chrome_RenderWidgetHostHWND")renderers.Add(handle);
        return true;
      },IntPtr.Zero);
      if(renderers.Count>1)throw new Exception("Expected one Chromium document window, found "+renderers.Count+".");
      var documentWindow=renderers.Count==1?renderers[0]:Window;
      Stage("connecting to Chromium document window "+documentWindow);
      IAccessible accessible;var iid=typeof(IAccessible).GUID;
      AccessibleObjectFromWindow(documentWindow,0xFFFFFFFC,ref iid,out accessible); // OBJID_CLIENT
      Stage("document accessibility children: "+accessible.accChildCount);
      var queue=new Queue<IAccessible>();queue.Enqueue(accessible);int visited=0;
      while(queue.Count>0 && visited++<200) {
        var node=queue.Dequeue();int role=Convert.ToInt32(node.get_accRole(0));
        if(role==15) {accessible=node;break;} // ROLE_SYSTEM_DOCUMENT
        for(int i=1;i<=node.accChildCount;i++) {var child=node.get_accChild(i) as IAccessible;if(child!=null)queue.Enqueue(child);}
      }
      Root=Automation.ElementFromIAccessible(accessible,0);
      RefreshControls();
    }
  }
  static bool SamePath(string a,string b) {return String.Equals(Path.GetFullPath(a),Path.GetFullPath(b),StringComparison.OrdinalIgnoreCase);}
  static IUIAutomationElement[] Elements(int type,string name) {
    if(Controls==null)RefreshControls();
    return Controls.Where(e=>e.CachedControlType==type && (name==null || e.CachedName==name) && e.CachedIsOffscreen==0).ToArray();
  }
  static IUIAutomationElement One(int type,string name) {
    var matches=Elements(type,name);
    if(matches.Length!=1)throw new Exception("Expected one visible UI control: "+name+" (matched "+matches.Length+"). Keep one chat pane open.");
    return matches[0];
  }
  static string Value(IUIAutomationElement element) {return ((IUIAutomationValuePattern)element.GetCurrentPattern(10002)).CurrentValue;}
  static void ReloadControls() {
    Root=Automation.ElementFromHandle(Window);Controls=null;UsedAccessibleRoot=false;RefreshControls();
  }
  internal static bool MatchesValue(string actual,string expected,bool prompt) {
    if(actual==null)return false;
    actual=actual.Replace("\r\n","\n");expected=expected.Replace("\r\n","\n");
    // UIA can expose contenteditable's terminal paragraph marker as one extra LF.
    // The runner also verifies the exact saved clientInput before Send.
    return actual==expected || (prompt && actual==expected+"\n");
  }
  internal static void WaitForValue(Func<string> read,string value,string label,bool prompt,Action pause,int attempts) {
    for(int attempt=0;attempt<attempts;attempt++) {
      if(MatchesValue(read(),value,prompt))return;
      pause();
    }
    throw new Exception("Timed out waiting for "+label+" to update. The input was not resent.");
  }
  static void Set(Func<IUIAutomationElement> locate,string value,string label,bool prompt=false) {
    ReloadControls();
    if(MatchesValue(Value(locate()),value,prompt)) {Stage(label+" already matches");return;}
    Stage("focusing "+label);
    locate().SetFocus();Thread.Sleep(100);ReloadControls();
    Stage("setting "+label);
    ((IUIAutomationValuePattern)locate().GetCurrentPattern(10002)).SetValue(value);
    Stage("waiting for "+label+" to update");
    // Chromium dispatches SetValue asynchronously. Read fresh controls; never
    // re-send the input just because an immediate read still has the old value.
    WaitForValue(()=>{ReloadControls();return Value(locate());},value,label,prompt,()=>Thread.Sleep(100),30);
    Stage(label+" verified");
  }
  static void FocusButton(string name) {
    Stage("focusing "+name+" button");
    ReloadControls();One(Button,name).SetFocus();Thread.Sleep(100);ReloadControls();
  }
  static IUIAutomationElement Field(string label) {
    var caption=One(Text,label);var box=caption.CachedBoundingRectangle;
    var candidates=Elements(Edit,null).Where(e=>e.CachedName=="Enter text here" &&
      e.CachedBoundingRectangle.top>=box.bottom && Math.Abs(e.CachedBoundingRectangle.left-box.left)<50)
      .OrderBy(e=>e.CachedBoundingRectangle.top).ToArray();
    if(candidates.Length==0)throw new Exception("Cannot locate setting: "+label);
    return candidates[0];
  }
  static void Empty() {
    var contextEnabled=One(Button,"Context").CurrentIsEnabled;
    var draft=Value(One(Edit,"Chat input"));
    Stage("empty chat check: context_enabled="+contextEnabled+", input_length="+(draft==null?0:draft.Length)+", whitespace_only="+String.IsNullOrWhiteSpace(draft));
    CheckEmptyState(contextEnabled,draft);
  }
  internal static void CheckEmptyState(int contextEnabled,string draft) {
    if(contextEnabled!=0)throw new Exception("Context is not empty. Existing chat was not edited.");
    // Chromium's empty contenteditable can expose a newline through UIA.
    // Do not trim actual prompts/settings: only the empty-chat gate accepts it.
    if(!String.IsNullOrWhiteSpace(draft))throw new Exception("Chat input contains an unsent draft. Existing draft was not edited.");
  }
  static void Identity(Dictionary<string,object> input) {
    if(Value(Field("SHERPA_RUN_ID"))!=S(input,"token") || !SamePath(Value(Field("Canonical timeline DB")),S(input,"database")))
      throw new Exception("The active chat does not belong to this batch job.");
  }
  static void Ready() {
    Stage("checking model and plugin controls");
    if(Elements(Button,"Select a model to load (Ctrl +L)").Length>0)
      throw new Exception("Load the experiment model in LM Studio before starting the batch.");
    One(Button,"dfir-sherpa");
    Field("Canonical timeline DB");Field("SHERPA_RUN_ID");
    foreach(var name in new[]{"dataset_overview","search_records","get_record","get_context"}) {
      Stage("checking tool "+name);
      var tool=One(CheckBox,name);
      if(((IUIAutomationTogglePattern)tool.GetCurrentPattern(10015)).CurrentToggleState!=ToggleState.ToggleState_On)
        throw new Exception("Enable all four DFIR Sherpa tools before starting.");
    }
    // A batch does not change approval policy or click permission dialogs.
    int allowed=0;
    Stage("checking Tool approval policy");
    foreach(var combo in Elements(ComboBox,null)) {
      string value="";
      var pattern=combo.GetCurrentPattern(10002) as IUIAutomationValuePattern;
      if(pattern!=null)value=pattern.CurrentValue;
      value=value.Trim().ToLowerInvariant();
      if(value=="allow" || value=="always allow" || value=="always")allowed++;
      else if(value!="per tool")throw new Exception("Tools require approval or have an unknown policy. Configure the four read-only tools for unattended use yourself, then retry.");
    }
    if(allowed==0)throw new Exception("Could not verify unattended Tool permissions.");
    if(Elements(Button,"Stop").Length>0 || Elements(Button,"Stop generation").Length>0)
      throw new Exception("Wait for the current model response to finish.");
    Stage("checking chat button and input capabilities");
    if(!(One(Button,"New").GetCurrentPattern(10000) is IUIAutomationInvokePattern))
      throw new Exception("The New chat button cannot be invoked. Open the Chats sidebar.");
    foreach(var field in new[]{Field("Canonical timeline DB"),Field("SHERPA_RUN_ID"),One(Edit,"Chat input")}) {
      var value=field.GetCurrentPattern(10002) as IUIAutomationValuePattern;
      if(value==null || value.CurrentIsReadOnly!=0)throw new Exception("A required chat/settings input is not editable.");
    }
    if(!(One(Button,"Send").GetCurrentPattern(10000) is IUIAutomationInvokePattern))
      throw new Exception("The Send button does not support automation.");
    Stage("ready");
  }
  static void Connect(string executable,bool restore) {
    Stage("locating LM Studio window");
    var matches=new List<Process>();
    foreach(var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(executable))) {
      try {if(process.MainWindowHandle!=IntPtr.Zero && SamePath(process.MainModule.FileName,executable))matches.Add(process);}catch{}
    }
    if(matches.Count!=1)throw new Exception("Expected exactly one LM Studio window.");
    Window=matches[0].MainWindowHandle;
    // A background launcher is not entitled to steal foreground focus. Restore a
    // minimized window, then target its controls directly without global keystrokes.
    if(IsIconic(Window)) {
      if(!restore)throw new Exception("LM Studio is minimized. Open its window before checking readiness.");
      ShowWindowAsync(Window,9); // SW_RESTORE
      var deadline=DateTime.UtcNow.AddSeconds(5);
      while(IsIconic(Window) && DateTime.UtcNow<deadline)Thread.Sleep(100);
      if(IsIconic(Window))throw new Exception("Restore the LM Studio window before starting the batch.");
    }
    Stage("connecting to LM Studio accessibility (window "+Window+")");
    Automation=(IUIAutomation2)new CUIAutomation8();
    Automation.ConnectionTimeout=3000;Automation.TransactionTimeout=5000;
    Root=Automation.ElementFromHandle(Window);Controls=null;UsedAccessibleRoot=false;
  }
  static void Action(Dictionary<string,object> input) {
    string action=S(input,"action");Connect(S(input,"app_path"),!action.StartsWith("inspect"));
    if(action=="preflight" || action=="inspect") {Ready();return;}
    if(action=="inspect-empty") {Ready();Empty();return;}
    if(action=="new") {
      Ready();FocusButton("New");
      var create=One(Button,"New");var invoke=create.GetCurrentPattern(10000) as IUIAutomationInvokePattern;
      if(create.CurrentIsEnabled==0 || invoke==null)
        throw new Exception("LM Studio's New chat button is unavailable. Open the Chats sidebar before starting.");
      Stage("invoking New button");invoke.Invoke();
      var end=DateTime.UtcNow.AddSeconds(15);
      string lastError="New chat did not become empty.";
      while(DateTime.UtcNow<end) {Thread.Sleep(250);try {RefreshControls();Empty();return;}catch(Exception error){lastError=error.Message;}}
      throw new Exception("New chat verification failed: "+lastError+" No database or prompt was changed.");
    }
    if(action=="configure") {
      Ready();Empty();Set(()=>Field("SHERPA_RUN_ID"),S(input,"token"),"SHERPA_RUN_ID");
      Set(()=>Field("Canonical timeline DB"),S(input,"database"),"Canonical timeline DB");Identity(input);return;
    }
    if(action=="prepare") {
      Ready();Empty();Identity(input);Set(()=>One(Edit,"Chat input"),S(input,"prompt"),"Chat input",true);return;
    }
    if(action=="clear-prepared") {
      // Diagnostic cleanup may clear only its exact, unsent prepared draft.
      // Never clear a modified draft or a chat that has acquired any context.
      Ready();Identity(input);
      if(One(Button,"Context").CurrentIsEnabled!=0 || !MatchesValue(Value(One(Edit,"Chat input")),S(input,"prompt"),true))
        throw new Exception("Draft changed; diagnostic cleanup refused.");
      Set(()=>One(Edit,"Chat input"),"","Chat input",true);Empty();return;
    }
    if(action=="submit") {
      Ready();FocusButton("Send");Identity(input);
      if(One(Button,"Context").CurrentIsEnabled!=0 || !MatchesValue(Value(One(Edit,"Chat input")),S(input,"prompt"),true))
        throw new Exception("Prepared prompt or chat context changed. Prompt was not sent.");
      var send=One(Button,"Send");
      if(send.CurrentIsEnabled==0)throw new Exception("Send is disabled; prompt was not submitted.");
      Stage("invoking Send button");((IUIAutomationInvokePattern)send.GetCurrentPattern(10000)).Invoke();return;
    }
    throw new Exception("Unknown UI action.");
  }
  static int CompareNames(string a,string b) {
    var left=Regex.Split(Path.GetFileName(a),"([0-9]+)");
    var right=Regex.Split(Path.GetFileName(b),"([0-9]+)");
    for(int i=0;i<Math.Min(left.Length,right.Length);i++) {
      int compared;
      if(i%2==1) {
        string x=left[i].TrimStart('0'),y=right[i].TrimStart('0');
        compared=x.Length.CompareTo(y.Length);
        if(compared==0)compared=StringComparer.Ordinal.Compare(x,y);
      } else compared=StringComparer.OrdinalIgnoreCase.Compare(left[i],right[i]);
      if(compared!=0)return compared;
    }
    int length=left.Length.CompareTo(right.Length);
    return length!=0?length:StringComparer.Ordinal.Compare(a,b);
  }
  static string[] FolderDatabases(string folder) {
    var extensions=new HashSet<string>(new[]{".sqlite",".sqlite3",".db"},StringComparer.OrdinalIgnoreCase);
    return Directory.GetFiles(Path.GetFullPath(folder),"*",SearchOption.TopDirectoryOnly)
      .Where(p=>extensions.Contains(Path.GetExtension(p)) && (File.GetAttributes(p)&FileAttributes.ReparsePoint)==0)
      .OrderBy(p=>p,Comparer<string>.Create(CompareNames)).ToArray();
  }
  static void MoveItem(CheckedListBox list,int offset) {
    int from=list.SelectedIndex,to=from+offset;
    if(from<0 || to<0 || to>=list.Items.Count)return;
    var item=list.Items[from];bool check=list.GetItemChecked(from);
    list.Items.RemoveAt(from);list.Items.Insert(to,item);list.SetItemChecked(to,check);list.SelectedIndex=to;
  }
  static int Wizard(string path,string defaultPrompt) {
    Application.EnableVisualStyles();
    var form=new Form {Text="DFIR Sherpa - Sequential Experiments",Width=900,Height=790,StartPosition=FormStartPosition.CenterScreen};
    var label=new Label {Text="Choose a folder, CHECK the DBs to run, and arrange them with Up/Down.\nChecked DBs run TOP TO BOTTOM: one new chat per DB, with the SAME prompt.",Left=15,Top=15,Width=850,Height=45};
    var folder=new Button {Text="Choose folder",Left=15,Top=65,Width=130};
    var location=new TextBox {ReadOnly=true,Left=155,Top=68,Width=700,Text="Choose a folder or add individual files."};
    var list=new CheckedListBox {Left=15,Top=105,Width=840,Height=195,HorizontalScrollbar=true,CheckOnClick=true};
    var add=new Button {Text="Add SQLite files",Left=15,Top=315,Width=135};
    var remove=new Button {Text="Remove",Left=160,Top=315,Width=90};
    var up=new Button {Text="Up",Left=260,Top=315,Width=80};
    var down=new Button {Text="Down",Left=350,Top=315,Width=80};
    var all=new Button {Text="Check all",Left=445,Top=315,Width=110};
    var none=new Button {Text="Uncheck all",Left=565,Top=315,Width=110};
    var promptLabel=new Label {Text="Common prompt (sent unchanged to every new chat)",Left=15,Top=355,Width=840,Height=20};
    var prompt=new TextBox {Multiline=true,AcceptsReturn=true,AcceptsTab=true,ScrollBars=ScrollBars.Both,WordWrap=true,Left=15,Top=380,Width=840,Height=270};
    if(File.Exists(defaultPrompt))prompt.Text=File.ReadAllText(defaultPrompt,Encoding.UTF8);
    var start=new Button {Text="Start batch",Left=675,Top=680,Width=180,Height=35};
    var cancel=new Button {Text="Cancel",Left=485,Top=680,Width=180,Height=35};
    folder.Click+=(s,e)=>{using(var dialog=new FolderBrowserDialog {Description="Choose the folder containing your SQLite databases (no subfolders).",ShowNewFolderButton=false}) {
      if(dialog.ShowDialog(form)!=DialogResult.OK)return;
      try {
        var files=FolderDatabases(dialog.SelectedPath);
        list.Items.Clear();foreach(var file in files)list.Items.Add(file,false);
        location.Text=Path.GetFullPath(dialog.SelectedPath);
        if(files.Length==0)MessageBox.Show(form,"No .sqlite, .sqlite3 or .db files found in this folder.");
      } catch(Exception error) {MessageBox.Show(form,"Cannot read the folder: "+error.Message);}
    }};
    add.Click+=(s,e)=>{using(var dialog=new OpenFileDialog {Filter="SQLite database|*.sqlite;*.sqlite3;*.db|All files|*.*",Multiselect=true}) {
      if(dialog.ShowDialog(form)==DialogResult.OK)foreach(var item in dialog.FileNames)list.Items.Add(item,true);
    }};
    remove.Click+=(s,e)=>{if(list.SelectedIndex>=0)list.Items.RemoveAt(list.SelectedIndex);};
    up.Click+=(s,e)=>MoveItem(list,-1);
    down.Click+=(s,e)=>MoveItem(list,1);
    all.Click+=(s,e)=>{for(int i=0;i<list.Items.Count;i++)list.SetItemChecked(i,true);};
    none.Click+=(s,e)=>{for(int i=0;i<list.Items.Count;i++)list.SetItemChecked(i,false);};
    cancel.Click+=(s,e)=>{form.DialogResult=DialogResult.Cancel;form.Close();};
    start.Click+=(s,e)=>{
      var databases=list.CheckedItems.Cast<string>().ToArray();
      if(databases.Length==0 || databases.Length>100 || String.IsNullOrWhiteSpace(prompt.Text) || prompt.Text.Length>100000){MessageBox.Show(form,"Check 1..100 DBs and enter a prompt (1..100000 characters).");return;}
      using(var file=new FileStream(path,FileMode.CreateNew,FileAccess.Write))using(var writer=new StreamWriter(file,new UTF8Encoding(false)))
        writer.Write(Json.Serialize(new {databases,prompt=prompt.Text}));
      form.DialogResult=DialogResult.OK;form.Close();
    };
    form.Controls.AddRange(new Control[]{label,folder,location,list,add,remove,up,down,all,none,promptLabel,prompt,start,cancel});
    return form.ShowDialog()==DialogResult.OK?0:2;
  }
  [STAThread] static int Main(string[] args) {
    Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
    try {
      if(args.Length>0 && args[0]=="--wizard")return Wizard(args[1],args[2]);
      if(args.Length>0 && args[0]=="--list-folder") {Console.WriteLine(Json.Serialize(FolderDatabases(args[1])));return 0;}
      if(args.Length>0 && args[0]=="--self-test") {Console.WriteLine("{\"ok\":true}");return 0;}
      var input=Json.Deserialize<Dictionary<string,object>>(Console.In.ReadToEnd());
      // WinForms needs STA; cross-process UI Automation runs on a dedicated MTA
      // thread to avoid apartment/message-pump stalls in Chromium providers.
      Exception failure=null;
      var worker=new Thread(()=>{try {Action(input);}catch(Exception error){failure=error;}});
      worker.IsBackground=true;worker.SetApartmentState(ApartmentState.MTA);worker.Start();
      if(!worker.Join(25000))throw new Exception("LM Studio UI inspection/action exceeded 25 seconds. No automatic retry was attempted.");
      if(failure!=null)throw failure;
      Console.WriteLine("{\"ok\":true}");return 0;
    } catch(Exception error) {Console.WriteLine(Json.Serialize(new {ok=false,error=error.Message}));return 1;}
  }
}
