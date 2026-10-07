// Fixed Windows worker host, promoted from the validated Pi spike Job Object implementation.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

class WorkerHost {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr MinWorking, MaxWorking; public uint ActiveProcesses;
        public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A,B,C,D,E,F; }
    [StructLayout(LayoutKind.Sequential)] struct Limits {
        public BasicLimits Basic; public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
        public int Size; public string Reserved, Desktop, Title;
        public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags;
        public ushort Show, ReservedSize; public IntPtr ReservedPtr, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public IntPtr Process, Thread; public uint Pid, Tid;
    }
    [DllImport("kernel32", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr sa, string name);
    [DllImport("kernel32", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref Limits limits, uint size);
    [DllImport("kernel32", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo info);
    [DllImport("kernel32", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32")] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32", SetLastError=true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint timeout);
    [DllImport("kernel32")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32")] static extern bool TerminateProcess(IntPtr process, uint code);

    // Windows CRT quoting, including trailing backslashes and embedded quotes.
    static string Quote(string value) {
        var b = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            b.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); slashes = 0; b.Append(c);
        }
        b.Append('\\', slashes * 2); return b.Append('"').ToString();
    }
    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static int Main(string[] args) {
        IntPtr job = IntPtr.Zero, parent = IntPtr.Zero; var child = new ProcessInfo();
        try {
            if (args.Length < 3 || args[0] != "job") return 64;
            parent = OpenProcess(0x100000, false, int.Parse(args[1])); Check(parent != IntPtr.Zero);
            job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero);
            var limits = new Limits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
            var command = new StringBuilder();
            for (int i=2;i<args.Length;i++) { if (i>2) command.Append(' '); command.Append(Quote(args[i])); }
            var si = new Startup(); si.Size = Marshal.SizeOf(si); si.Flags=0x100;
            si.Input=GetStdHandle(-10); si.Output=GetStdHandle(-11); si.Error=GetStdHandle(-12);
            Check(CreateProcess(args[2], command, IntPtr.Zero, IntPtr.Zero, true, 0x4 | 0x08000000, IntPtr.Zero, null, ref si, out child));
            // Fail closed; unassigned child is still suspended and is terminated in finally.
            Check(AssignProcessToJobObject(job, child.Process));
            Check(ResumeThread(child.Thread) != uint.MaxValue);
            uint wait = WaitForMultipleObjects(2, new IntPtr[]{child.Process,parent}, false, uint.MaxValue);
            if (wait == 1) return 125; // Actual host disappeared: close Job even if stdin remains open.
            Check(wait == 0); uint code; Check(GetExitCodeProcess(child.Process, out code)); return (int)code;
        } catch (Exception e) {
            // Never include arguments, environment, stdin, or exception messages in diagnostics.
            Console.Error.WriteLine("native-host-failed:" + e.GetType().Name + ":" + e.HResult.ToString("X8")); return 126;
        } finally {
            if (child.Process != IntPtr.Zero) { TerminateProcess(child.Process, 125); CloseHandle(child.Process); }
            if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (parent != IntPtr.Zero) CloseHandle(parent);
        }
    }
}
