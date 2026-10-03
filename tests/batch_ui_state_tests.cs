using System;

// Exercises the same empty-chat gate used by the shipped helper, without UI access.
class BatchUiStateTests {
  static void Rejected(int enabled,string draft) {
    try {SherpaBatchUi.CheckEmptyState(enabled,draft);}
    catch(Exception) {return;}
    throw new Exception("Expected existing context/draft to be protected.");
  }
  static int Main() {
    try {
      foreach(var blank in new[]{null,"","\n","\r\n"," \t","\u00a0"})
        SherpaBatchUi.CheckEmptyState(0,blank);
      Rejected(0,"Existing prompt");Rejected(0,"\nExisting prompt\n");
      Rejected(0,"\u200b");Rejected(1,"");Rejected(1,"\n");Rejected(-1,null);
      Console.WriteLine("12 empty-chat and draft-protection cases passed");
      int reads=0,pauses=0;
      SherpaBatchUi.WaitForValue(()=>++reads<3?"old value":"desired","desired","fixture",false,()=>pauses++,5);
      if(reads!=3 || pauses!=2)throw new Exception("Async input was not awaited.");
      if(SherpaBatchUi.MatchesValue("path\n","path",false))throw new Exception("Setting value was trimmed.");
      if(!SherpaBatchUi.MatchesValue("prompt\n","prompt",true))throw new Exception("UIA paragraph marker was not handled.");
      if(SherpaBatchUi.MatchesValue("other\n","prompt",true))throw new Exception("Different prompt was accepted.");
      bool timedOut=false;
      try {SherpaBatchUi.WaitForValue(()=>"old value","desired","fixture",false,()=>{},2);}
      catch(Exception) {timedOut=true;}
      if(!timedOut)throw new Exception("Missing update was accepted.");
      Console.WriteLine("Async value and exact prompt checks passed");return 0;
    } catch(Exception error) {Console.Error.WriteLine(error.Message);return 1;}
  }
}
