using System;
using System.IO;
// Kernel-owned handle: a crashed parent closes stdin, releasing the lease without PID guessing.
class DataLease {
    static int Main(string[] args) {
        try {
            using (var file = new FileStream(args[0], FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) {
                Console.WriteLine("LOCKED"); Console.Out.Flush();
                Console.In.ReadToEnd();
            }
            return 0;
        } catch { return 1; }
    }
}
