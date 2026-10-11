<#
  Nexo Controle — deixa alguém da chamada do Nexo controlar este PC (mouse e teclado),
  SÓ depois que você clicar em "Permitir" no Nexo, e só enquanto esta janela estiver aberta.

  Como usar:
    • Clique com o botão direito neste arquivo → "Executar com o PowerShell".
    • Na primeira vez ele se instala e cria o atalho "Nexo Controle" na Área de Trabalho.
    • Deixe a janela aberta enquanto quiser poder ser controlado. Fechou = desligou.
    • Para retomar o controle na hora: mexa no seu mouse ou aperte Ctrl + Alt + End.

  Segurança:
    • Só aceita conexões deste próprio PC (127.0.0.1) e só do site do seu Nexo.
    • Não abre nenhuma porta para a internet.

  Desinstalar: powershell -ExecutionPolicy Bypass -File nexo-controle.ps1 -Desinstalar
#>
param([switch]$Desinstalar)

$ErrorActionPreference = 'Stop'
$Site = '__NEXO_SITE__'
$Porta = 47800
$Versao = '1.0'
$Pasta = Join-Path $env:LOCALAPPDATA 'NexoControle'
$Instalado = Join-Path $Pasta 'nexo-controle.ps1'
$Atalho = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Nexo Controle.lnk'

if ($Desinstalar) {
  Remove-Item -LiteralPath $Atalho -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Pasta -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host 'Nexo Controle removido.' -ForegroundColor Green
  return
}

if ($Site -like '__NEXO*') {
  Write-Host 'Este arquivo precisa ser baixado pelo próprio Nexo (botão "Baixar Nexo Controle").' -ForegroundColor Red
  Read-Host 'Aperte Enter para fechar'
  return
}

try { $Host.UI.RawUI.WindowTitle = 'Nexo Controle' } catch { }

# ---- Instala (copia para uma pasta fixa e cria o atalho)
if ($PSCommandPath -and ($PSCommandPath -ne $Instalado)) {
  New-Item -ItemType Directory -Force -Path $Pasta | Out-Null
  Copy-Item -LiteralPath $PSCommandPath -Destination $Instalado -Force
  try { Unblock-File -LiteralPath $Instalado } catch { }
  try {
    $wsh = New-Object -ComObject WScript.Shell
    $lnk = $wsh.CreateShortcut($Atalho)
    $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $lnk.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $Instalado + '"'
    $lnk.WorkingDirectory = $Pasta
    $lnk.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',43'
    $lnk.Description = 'Deixa alguém do Nexo controlar este PC (só com sua permissão)'
    $lnk.Save()
    Write-Host 'Atalho "Nexo Controle" criado na Área de Trabalho.' -ForegroundColor Green
  } catch {
    Write-Host 'Não consegui criar o atalho (sem problema, dá para abrir por este arquivo).' -ForegroundColor Yellow
  }
}

$codigo = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Nexo
{
    public static class Controle
    {
        // ------------------------------------------------------------ Windows
        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
        [StructLayout(LayoutKind.Explicit)]
        struct InputUnion
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
            [FieldOffset(0)] public HARDWAREINPUT hi;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct INPUT { public uint type; public InputUnion u; }
        [StructLayout(LayoutKind.Sequential)]
        struct POINT { public int x; public int y; }
        [StructLayout(LayoutKind.Sequential)]
        struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }

        [DllImport("user32.dll", SetLastError = true)]
        static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
        [DllImport("user32.dll")]
        static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")]
        static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")]
        static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")]
        static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll", SetLastError = true)]
        static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
        delegate IntPtr LowLevelProc(int nCode, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr SetWindowsHookEx(int idHook, LowLevelProc lpfn, IntPtr hMod, uint dwThreadId);
        [DllImport("user32.dll")]
        static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll")]
        static extern IntPtr GetModuleHandle(string name);

        const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
        const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
        const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;
        const uint KEYEVENTF_EXTENDEDKEY = 0x0001, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_SCANCODE = 0x0008;

        // ------------------------------------------------------------ Estado
        static string allowedOrigin;
        static int port;
        static string version;
        static readonly object sendLock = new object();
        static TcpClient currentClient;
        static NetworkStream current;
        static volatile bool granted;
        static string controllerName = "";
        static Rectangle target;
        static int hostActiveTick;
        static int lastNotifyTick;
        static readonly object inputLock = new object();
        static readonly HashSet<int> keysDown = new HashSet<int>();
        static readonly HashSet<int> buttonsDown = new HashSet<int>();
        static Dictionary<string, int> scanCodes;
        static LowLevelProc mouseProc; // guardado para o coletor de lixo não apagar
        static IntPtr mouseHook = IntPtr.Zero;

        static void Log(string text)
        {
            Console.WriteLine(DateTime.Now.ToString("HH:mm:ss") + "  " + text);
        }

        public static void Run(string origin, int listenPort, string ver)
        {
            allowedOrigin = origin.TrimEnd('/');
            port = listenPort;
            version = ver;
            hostActiveTick = Environment.TickCount - 600000;
            try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }
            catch { try { SetProcessDPIAware(); } catch { } }
            BuildScanCodes();
            target = Screen.PrimaryScreen.Bounds;

            Thread ui = new Thread(UiThread);
            ui.IsBackground = true;
            ui.SetApartmentState(ApartmentState.STA);
            ui.Start();

            TcpListener listener = new TcpListener(IPAddress.Loopback, port);
            try { listener.Start(); }
            catch (SocketException)
            {
                Log("O Nexo Controle já está aberto em outra janela (ou a porta " + port + " está ocupada).");
                return;
            }
            Log("Nexo Controle ligado. Esperando o Nexo (" + allowedOrigin + ").");
            Log("Ninguém controla nada sem você clicar em \"Permitir\" no Nexo.");
            Log("Para retomar o controle: mexa no seu mouse ou aperte Ctrl + Alt + End. Feche esta janela para desligar.");
            while (true)
            {
                TcpClient client = listener.AcceptTcpClient();
                Thread t = new Thread(delegate () { HandleClient(client); });
                t.IsBackground = true;
                t.Start();
            }
        }

        // ------------------------------------------------------------ Atalho Ctrl+Alt+End e mouse de verdade
        class HotkeyWindow : NativeWindow
        {
            public HotkeyWindow() { CreateHandle(new CreateParams()); }
            protected override void WndProc(ref Message m)
            {
                if (m.Msg == 0x0312) OnHotkey();
                base.WndProc(ref m);
            }
        }

        static void UiThread()
        {
            HotkeyWindow w = new HotkeyWindow();
            // MOD_ALT | MOD_CONTROL | MOD_NOREPEAT, tecla End
            if (!RegisterHotKey(w.Handle, 1, 0x0001 | 0x0002 | 0x4000, 0x23))
                Log("Aviso: não consegui registrar o atalho Ctrl+Alt+End (outro programa usa). Use o botão \"Parar controle\" no Nexo.");
            mouseProc = MouseHook;
            mouseHook = SetWindowsHookEx(14, mouseProc, GetModuleHandle(null), 0);
            Application.Run();
        }

        static void OnHotkey()
        {
            if (!granted) return;
            EndControl("Você retomou o controle (Ctrl+Alt+End).");
            SendText("{\"t\":\"revoked\"}");
        }

        static IntPtr MouseHook(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0 && granted)
            {
                MSLLHOOKSTRUCT info = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                if ((info.flags & 0x01) == 0) // não foi o Nexo: é o mouse de verdade
                {
                    bool significant = true;
                    if (wParam.ToInt32() == 0x0200)
                    {
                        POINT cur;
                        if (GetCursorPos(out cur)) significant = Math.Abs(info.pt.x - cur.x) + Math.Abs(info.pt.y - cur.y) > 3;
                    }
                    if (significant)
                    {
                        hostActiveTick = Environment.TickCount;
                        if (Environment.TickCount - lastNotifyTick > 700)
                        {
                            lastNotifyTick = Environment.TickCount;
                            ThreadPool.QueueUserWorkItem(delegate (object o) { SendText("{\"t\":\"host-active\"}"); });
                        }
                    }
                }
            }
            return CallNextHookEx(mouseHook, nCode, wParam, lParam);
        }

        static bool HostActive() { return Environment.TickCount - hostActiveTick < 1000; }

        // ------------------------------------------------------------ WebSocket (só 127.0.0.1)
        static void HandleClient(TcpClient c)
        {
            NetworkStream s = null;
            bool mine = false;
            try
            {
                c.NoDelay = true;
                s = c.GetStream();
                s.ReadTimeout = 10000;
                string head = ReadHttpHeader(s);
                if (head == null) { c.Close(); return; }
                Dictionary<string, string> hdr = ParseHeaders(head);
                string origin = Get(hdr, "origin");
                string host = Get(hdr, "host");
                string key = Get(hdr, "sec-websocket-key");
                string upgrade = Get(hdr, "upgrade");
                if (key == null || upgrade == null || upgrade.ToLowerInvariant() != "websocket") { WriteHttp(s, "400 Bad Request"); c.Close(); return; }
                if (origin == null || !string.Equals(origin.TrimEnd('/'), allowedOrigin, StringComparison.OrdinalIgnoreCase))
                {
                    WriteHttp(s, "403 Forbidden");
                    Log("Conexão recusada (site não autorizado: " + (origin ?? "?") + ").");
                    c.Close();
                    return;
                }
                if (host == null || (host != "127.0.0.1:" + port && host != "localhost:" + port)) { WriteHttp(s, "403 Forbidden"); c.Close(); return; }

                string accept;
                using (SHA1 sha = SHA1.Create())
                    accept = Convert.ToBase64String(sha.ComputeHash(Encoding.ASCII.GetBytes(key.Trim() + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
                byte[] resp = Encoding.ASCII.GetBytes("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
                s.Write(resp, 0, resp.Length);
                s.ReadTimeout = Timeout.Infinite;

                // A conexão nova (ex.: página recarregada) substitui a antiga.
                lock (sendLock)
                {
                    if (currentClient != null) { try { currentClient.Close(); } catch { } }
                    currentClient = c;
                    current = s;
                    mine = true;
                }
                if (granted) EndControl("Controle encerrado (o Nexo reconectou).");

                JavaScriptSerializer ser = new JavaScriptSerializer();
                while (true)
                {
                    string msg = ReadFrame(s);
                    if (msg == null) break;
                    HandleMessage(ser, msg);
                }
            }
            catch (Exception) { }
            finally
            {
                bool wasCurrent = false;
                lock (sendLock)
                {
                    if (mine && currentClient == c) { currentClient = null; current = null; wasCurrent = true; }
                }
                if (wasCurrent && granted) EndControl("Controle encerrado (o Nexo foi fechado).");
                try { c.Close(); } catch { }
            }
        }

        static string ReadHttpHeader(NetworkStream s)
        {
            List<byte> buf = new List<byte>();
            while (buf.Count < 8192)
            {
                int b = s.ReadByte();
                if (b < 0) return null;
                buf.Add((byte)b);
                int n = buf.Count;
                if (n >= 4 && buf[n - 4] == 13 && buf[n - 3] == 10 && buf[n - 2] == 13 && buf[n - 1] == 10)
                    return Encoding.ASCII.GetString(buf.ToArray());
            }
            return null;
        }

        static Dictionary<string, string> ParseHeaders(string head)
        {
            Dictionary<string, string> d = new Dictionary<string, string>();
            string[] lines = head.Split(new string[] { "\r\n" }, StringSplitOptions.RemoveEmptyEntries);
            for (int i = 1; i < lines.Length; i++)
            {
                int k = lines[i].IndexOf(':');
                if (k <= 0) continue;
                d[lines[i].Substring(0, k).Trim().ToLowerInvariant()] = lines[i].Substring(k + 1).Trim();
            }
            return d;
        }

        static string Get(Dictionary<string, string> d, string k)
        {
            string v;
            return d.TryGetValue(k, out v) ? v : null;
        }

        static void WriteHttp(NetworkStream s, string status)
        {
            byte[] b = Encoding.ASCII.GetBytes("HTTP/1.1 " + status + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            try { s.Write(b, 0, b.Length); } catch { }
        }

        static byte[] ReadExact(NetworkStream s, int n)
        {
            byte[] buf = new byte[n];
            int got = 0;
            while (got < n)
            {
                int r = s.Read(buf, got, n - got);
                if (r <= 0) return null;
                got += r;
            }
            return buf;
        }

        static string ReadFrame(NetworkStream s)
        {
            List<byte> message = null;
            while (true)
            {
                byte[] h2 = ReadExact(s, 2);
                if (h2 == null) return null;
                bool fin = (h2[0] & 0x80) != 0;
                int opcode = h2[0] & 0x0F;
                bool masked = (h2[1] & 0x80) != 0;
                long len = h2[1] & 0x7F;
                if (len == 126)
                {
                    byte[] e = ReadExact(s, 2);
                    if (e == null) return null;
                    len = (e[0] << 8) | e[1];
                }
                else if (len == 127)
                {
                    byte[] e = ReadExact(s, 8);
                    if (e == null) return null;
                    len = 0;
                    for (int i = 0; i < 8; i++) len = (len << 8) | e[i];
                }
                if (!masked || len > 65536) return null;
                byte[] mask = ReadExact(s, 4);
                if (mask == null) return null;
                byte[] data = len > 0 ? ReadExact(s, (int)len) : new byte[0];
                if (data == null) return null;
                for (int i = 0; i < data.Length; i++) data[i] = (byte)(data[i] ^ mask[i % 4]);

                if (opcode == 8) return null;                       // fechar
                if (opcode == 9) { SendFrame(s, 0xA, data); continue; } // ping -> pong
                if (opcode == 0xA) continue;
                if (opcode == 0 || opcode == 1 || opcode == 2)
                {
                    if (message == null) message = new List<byte>();
                    message.AddRange(data);
                    if (message.Count > 65536) return null;
                    if (fin) return Encoding.UTF8.GetString(message.ToArray());
                    continue;
                }
                return null;
            }
        }

        static void SendFrame(NetworkStream s, int opcode, byte[] payload)
        {
            List<byte> f = new List<byte>();
            f.Add((byte)(0x80 | opcode));
            if (payload.Length < 126) f.Add((byte)payload.Length);
            else if (payload.Length < 65536) { f.Add(126); f.Add((byte)(payload.Length >> 8)); f.Add((byte)(payload.Length & 0xFF)); }
            else
            {
                f.Add(127);
                for (int i = 7; i >= 0; i--) f.Add((byte)(((long)payload.Length >> (8 * i)) & 0xFF));
            }
            f.AddRange(payload);
            byte[] all = f.ToArray();
            lock (sendLock) { s.Write(all, 0, all.Length); }
        }

        static void SendText(string text)
        {
            NetworkStream s;
            lock (sendLock) { s = current; }
            if (s == null) return;
            try { SendFrame(s, 1, Encoding.UTF8.GetBytes(text)); } catch { }
        }

        // ------------------------------------------------------------ Mensagens do Nexo
        static double Num(Dictionary<string, object> d, string k)
        {
            object v;
            if (!d.TryGetValue(k, out v) || v == null) return 0;
            try { return Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture); } catch { return 0; }
        }
        static bool Bool(Dictionary<string, object> d, string k)
        {
            object v;
            return d.TryGetValue(k, out v) && v is bool && (bool)v;
        }
        static string Str(Dictionary<string, object> d, string k)
        {
            object v;
            return d.TryGetValue(k, out v) && v != null ? v.ToString() : "";
        }

        static void HandleMessage(JavaScriptSerializer ser, string msg)
        {
            Dictionary<string, object> d;
            try { d = ser.Deserialize<Dictionary<string, object>>(msg); } catch { return; }
            if (d == null) return;
            string t = Str(d, "t");
            switch (t)
            {
                case "hello": SendHello(ser); break;
                case "grant":
                    {
                        Screen[] all = Screen.AllScreens;
                        int i = (int)Num(d, "screen");
                        target = (i >= 0 && i < all.Length) ? all[i].Bounds : Screen.PrimaryScreen.Bounds;
                        controllerName = Str(d, "name");
                        if (controllerName.Length > 40) controllerName = controllerName.Substring(0, 40);
                        granted = true;
                        Log(controllerName + " está controlando este PC. (Ctrl+Alt+End para retomar)");
                        break;
                    }
                case "revoke": if (granted) EndControl("Controle encerrado."); break;
                case "m": if (granted && !HostActive()) MoveTo(Num(d, "x"), Num(d, "y")); break;
                case "b": if (granted) Button((int)Num(d, "b"), Bool(d, "d")); break;
                case "w": if (granted && !HostActive()) Wheel((int)Num(d, "dy"), (int)Num(d, "dx")); break;
                case "k": if (granted) Key(Str(d, "c"), Bool(d, "d")); break;
                case "up": ReleaseAll(); break;
            }
        }

        static void SendHello(JavaScriptSerializer ser)
        {
            List<Dictionary<string, object>> screens = new List<Dictionary<string, object>>();
            foreach (Screen sc in Screen.AllScreens)
            {
                Dictionary<string, object> o = new Dictionary<string, object>();
                o["x"] = sc.Bounds.X; o["y"] = sc.Bounds.Y; o["w"] = sc.Bounds.Width; o["h"] = sc.Bounds.Height;
                o["primary"] = sc.Primary;
                screens.Add(o);
            }
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["t"] = "hello";
            d["version"] = version;
            d["screens"] = screens;
            SendText(ser.Serialize(d));
        }

        static void EndControl(string why)
        {
            granted = false;
            ReleaseAll();
            Log(why);
        }

        // ------------------------------------------------------------ Mouse e teclado
        static void Send(INPUT input)
        {
            SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT)));
        }

        static INPUT MouseInput(int dx, int dy, uint data, uint flags)
        {
            INPUT i = new INPUT();
            i.type = INPUT_MOUSE;
            i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = data; i.u.mi.dwFlags = flags;
            return i;
        }

        static void MoveTo(double x, double y)
        {
            if (x < 0) x = 0; if (x > 1) x = 1; if (y < 0) y = 0; if (y > 1) y = 1;
            Rectangle b = target;
            double px = b.Left + x * (b.Width - 1);
            double py = b.Top + y * (b.Height - 1);
            int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
            if (vw < 2 || vh < 2) return;
            int nx = (int)Math.Round((px - vx) * 65535.0 / (vw - 1));
            int ny = (int)Math.Round((py - vy) * 65535.0 / (vh - 1));
            Send(MouseInput(nx, ny, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK));
        }

        static void Button(int b, bool down)
        {
            uint flags; uint data = 0;
            switch (b)
            {
                case 0: flags = down ? 0x0002u : 0x0004u; break;          // esquerdo
                case 1: flags = down ? 0x0008u : 0x0010u; break;          // direito
                case 2: flags = down ? 0x0020u : 0x0040u; break;          // meio
                case 3: flags = down ? 0x0080u : 0x0100u; data = 1; break; // voltar
                case 4: flags = down ? 0x0080u : 0x0100u; data = 2; break; // avançar
                default: return;
            }
            lock (inputLock)
            {
                if (down)
                {
                    if (HostActive()) return;
                    buttonsDown.Add(b);
                }
                else if (!buttonsDown.Remove(b)) return;
                Send(MouseInput(0, 0, data, flags));
            }
        }

        static void Wheel(int dy, int dx)
        {
            if (dy != 0) Send(MouseInput(0, 0, unchecked((uint)dy), MOUSEEVENTF_WHEEL));
            if (dx != 0) Send(MouseInput(0, 0, unchecked((uint)dx), MOUSEEVENTF_HWHEEL));
        }

        static void KeyRaw(int sc, bool down)
        {
            INPUT i = new INPUT();
            i.type = INPUT_KEYBOARD;
            i.u.ki.wScan = (ushort)(sc & 0xFF);
            i.u.ki.dwFlags = KEYEVENTF_SCANCODE | ((sc & 0x100) != 0 ? KEYEVENTF_EXTENDEDKEY : 0) | (down ? 0 : KEYEVENTF_KEYUP);
            Send(i);
        }

        static void Key(string code, bool down)
        {
            int sc;
            if (code == null || !scanCodes.TryGetValue(code, out sc)) return;
            lock (inputLock)
            {
                if (down)
                {
                    if (HostActive()) return;
                    keysDown.Add(sc);
                }
                else if (!keysDown.Remove(sc)) return;
                KeyRaw(sc, down);
            }
        }

        static void ReleaseAll()
        {
            lock (inputLock)
            {
                foreach (int sc in keysDown) KeyRaw(sc, false);
                keysDown.Clear();
                foreach (int b in new List<int>(buttonsDown))
                {
                    uint flags = b == 0 ? 0x0004u : b == 1 ? 0x0010u : b == 2 ? 0x0040u : 0x0100u;
                    uint data = b == 3 ? 1u : b == 4 ? 2u : 0u;
                    Send(MouseInput(0, 0, data, flags));
                }
                buttonsDown.Clear();
            }
        }

        // Código físico da tecla (KeyboardEvent.code) -> scan code. 0x100 = tecla "estendida".
        static void BuildScanCodes()
        {
            Dictionary<string, int> m = new Dictionary<string, int>();
            m["Escape"] = 0x01;
            string digits = "1234567890";
            for (int i = 0; i < 10; i++) m["Digit" + digits[i]] = 0x02 + i;
            m["Minus"] = 0x0C; m["Equal"] = 0x0D; m["Backspace"] = 0x0E; m["Tab"] = 0x0F;
            string row1 = "QWERTYUIOP";
            for (int i = 0; i < row1.Length; i++) m["Key" + row1[i]] = 0x10 + i;
            m["BracketLeft"] = 0x1A; m["BracketRight"] = 0x1B; m["Enter"] = 0x1C; m["ControlLeft"] = 0x1D;
            string row2 = "ASDFGHJKL";
            for (int i = 0; i < row2.Length; i++) m["Key" + row2[i]] = 0x1E + i;
            m["Semicolon"] = 0x27; m["Quote"] = 0x28; m["Backquote"] = 0x29; m["ShiftLeft"] = 0x2A; m["Backslash"] = 0x2B;
            string row3 = "ZXCVBNM";
            for (int i = 0; i < row3.Length; i++) m["Key" + row3[i]] = 0x2C + i;
            m["Comma"] = 0x33; m["Period"] = 0x34; m["Slash"] = 0x35; m["ShiftRight"] = 0x36;
            m["NumpadMultiply"] = 0x37; m["AltLeft"] = 0x38; m["Space"] = 0x39; m["CapsLock"] = 0x3A;
            for (int i = 0; i < 10; i++) m["F" + (i + 1)] = 0x3B + i;
            m["ScrollLock"] = 0x46;
            m["Numpad7"] = 0x47; m["Numpad8"] = 0x48; m["Numpad9"] = 0x49; m["NumpadSubtract"] = 0x4A;
            m["Numpad4"] = 0x4B; m["Numpad5"] = 0x4C; m["Numpad6"] = 0x4D; m["NumpadAdd"] = 0x4E;
            m["Numpad1"] = 0x4F; m["Numpad2"] = 0x50; m["Numpad3"] = 0x51; m["Numpad0"] = 0x52; m["NumpadDecimal"] = 0x53;
            m["IntlBackslash"] = 0x56; m["F11"] = 0x57; m["F12"] = 0x58;
            m["IntlRo"] = 0x73; m["NumpadComma"] = 0x7E; // teclado ABNT2: "/?" e "." do teclado numérico
            m["NumpadEnter"] = 0x11C; m["ControlRight"] = 0x11D; m["NumpadDivide"] = 0x135; m["PrintScreen"] = 0x137;
            m["AltRight"] = 0x138; m["Home"] = 0x147; m["ArrowUp"] = 0x148; m["PageUp"] = 0x149;
            m["ArrowLeft"] = 0x14B; m["ArrowRight"] = 0x14D; m["End"] = 0x14F; m["ArrowDown"] = 0x150;
            m["PageDown"] = 0x151; m["Insert"] = 0x152; m["Delete"] = 0x153;
            m["MetaLeft"] = 0x15B; m["MetaRight"] = 0x15C; m["ContextMenu"] = 0x15D;
            m["AudioVolumeMute"] = 0x120; m["AudioVolumeDown"] = 0x12E; m["AudioVolumeUp"] = 0x130;
            m["MediaPlayPause"] = 0x122; m["MediaTrackNext"] = 0x119; m["MediaTrackPrevious"] = 0x110; m["MediaStop"] = 0x124;
            scanCodes = m;
        }
    }
}
'@

Write-Host ''
Write-Host '  ===== Nexo Controle =====' -ForegroundColor Cyan
Write-Host ('  Site: ' + $Site)
Write-Host '  Deixe esta janela aberta enquanto quiser poder ser controlado.'
Write-Host ''

try {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing, System.Web.Extensions
  $refs = @(
    [System.Net.Sockets.TcpListener].Assembly.Location,      # System.dll
    [System.Linq.Enumerable].Assembly.Location,              # System.Core.dll
    [System.Windows.Forms.Form].Assembly.Location,
    [System.Drawing.Rectangle].Assembly.Location,
    [System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location
  ) | Select-Object -Unique
  Add-Type -TypeDefinition $codigo -ReferencedAssemblies $refs
} catch {
  Write-Host 'Erro ao preparar o Nexo Controle:' -ForegroundColor Red
  Write-Host $_.Exception.Message
  Read-Host 'Aperte Enter para fechar'
  return
}

try {
  [Nexo.Controle]::Run($Site, $Porta, $Versao)
} catch {
  Write-Host 'O Nexo Controle parou:' -ForegroundColor Red
  Write-Host $_.Exception.Message
}
Read-Host 'Aperte Enter para fechar'
