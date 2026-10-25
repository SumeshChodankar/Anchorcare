# Read-only report of Windows audio outputs, as JSON, for agent/audio-output.js.
# Changes nothing: it only asks Windows which speakers exist, how loud they are and
# whether they are muted, so the capture page can warn when a reply cannot be heard.
Add-Type -Language CSharp -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { [PreserveSig] int EnumAudioEndpoints(int flow, int mask, out IMMDeviceCollection c);
  [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection { int GetCount(out int c); int Item(int i, out IMMDevice d); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { [PreserveSig] int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore ps); [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id); }
[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore { int GetCount(out int c); int GetAt(int i, out PropertyKey k); int GetValue(ref PropertyKey k, out PropVariant v); }
[StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid fmtid; public int pid; }
[StructLayout(LayoutKind.Explicit)] struct PropVariant { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr ptr; }
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume { int A(); int B(); int C(); int D(); int SetMasterVolumeLevelScalar(float l, Guid g); int E();
  int GetMasterVolumeLevelScalar(out float l); int F(); int G(); int H(); int I(); int J(); int K(); int GetMute(out bool m); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }

public static class AnchorAudio {
  static string Name(IMMDevice d) {
    IPropertyStore ps; d.OpenPropertyStore(0, out ps);
    var key = new PropertyKey { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
    PropVariant v; ps.GetValue(ref key, out v); return Marshal.PtrToStringUni(v.ptr);
  }
  static string State(IMMDevice d, bool isDefault) {
    object o; var iid = typeof(IAudioEndpointVolume).GUID; d.Activate(ref iid, 23, IntPtr.Zero, out o);
    var vol = (IAudioEndpointVolume)o; float level; bool mute; vol.GetMasterVolumeLevelScalar(out level); vol.GetMute(out mute);
    string id; d.GetId(out id);
    return string.Format("{{\"id\":\"{0}\",\"name\":\"{1}\",\"volume\":{2},\"muted\":{3},\"isDefault\":{4}}}",
      id.Replace("\\", "\\\\").Replace("\"", "\\\""), Name(d).Replace("\\", "\\\\").Replace("\"", "\\\""),
      Math.Round(level * 100), mute ? "true" : "false", isDefault ? "true" : "false");
  }
  public static string Run() {
    var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
    IMMDevice def; string defId = null;
    if (en.GetDefaultAudioEndpoint(0, 0, out def) == 0) def.GetId(out defId);
    IMMDeviceCollection all; en.EnumAudioEndpoints(0, 1, out all); int n; all.GetCount(out n);
    var items = new List<string>();
    for (int i = 0; i < n; i++) { IMMDevice d; all.Item(i, out d); string id; d.GetId(out id); items.Add(State(d, id == defId)); }
    return "[" + string.Join(",", items) + "]";
  }
}
"@
[AnchorAudio]::Run()
