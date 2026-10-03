// Import the Windows UI Automation COM type library using the installed OS.
// Generated assemblies stay in outputs/.batch-runtime, never in source control.
using System;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.InteropServices;

class BuildUiaInterop : ITypeLibImporterNotifySink {
  [DllImport("oleaut32.dll",CharSet=CharSet.Unicode,PreserveSig=false)]
  static extern void LoadTypeLibEx(string file,int kind,[MarshalAs(UnmanagedType.Interface)] out object library);
  public void ReportEvent(ImporterEventKind kind,int code,string message) {
    if(kind==ImporterEventKind.ERROR_REFTOINVALIDTYPELIB)throw new Exception(message);
  }
  public Assembly ResolveRef(object typeLib) {throw new Exception("Unexpected UI Automation type library dependency.");}
  static int Main(string[] args) {
    try {
      object library;LoadTypeLibEx(args[0],2,out library); // REGKIND_NONE: no registry writes
      var assembly=new TypeLibConverter().ConvertTypeLibToAssembly(library,args[1],TypeLibImporterFlags.None,
        new BuildUiaInterop(),null,null,"SherpaNativeUia",null);
      assembly.Save(System.IO.Path.GetFileName(args[1]));return 0;
    } catch(Exception error) {Console.Error.WriteLine(error.Message);return 1;}
  }
}
