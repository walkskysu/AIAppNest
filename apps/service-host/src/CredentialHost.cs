using System;
using System.Security.Cryptography;

// Build-time helper. Secrets travel only over anonymous stdin/stdout pipes.
class CredentialHost {
    static int Main(string[] args) {
        byte[] input = null, output = null;
        try {
            if (args.Length != 1 || (args[0] != "protect" && args[0] != "unprotect")) return 64;
            input = Convert.FromBase64String(Console.In.ReadToEnd());
            output = args[0] == "protect"
                ? ProtectedData.Protect(input, null, DataProtectionScope.CurrentUser)
                : ProtectedData.Unprotect(input, null, DataProtectionScope.CurrentUser);
            Console.Write(Convert.ToBase64String(output));
            return 0;
        } catch { return 1; }
        finally {
            if (input != null) Array.Clear(input, 0, input.Length);
            if (output != null) Array.Clear(output, 0, output.Length);
        }
    }
}
