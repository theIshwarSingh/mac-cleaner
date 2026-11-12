// Mac Cleaner: native AppKit shell around the mac-cleaner local server.
// Starts the bundled single-file Node server (Contents/Resources/mac-cleaner-server),
// waits for its "mac-cleaner UI at http://127.0.0.1:<port>" line, and shows that
// page in a WKWebView. The server is attributed to this app for TCC, so granting
// the app Full Disk Access unlocks the Mail / Safari / permissions scanners.
import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var server: Process?
    private var serverURL: URL?
    private var status: NSTextField!

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        startServer()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        stopServer()
    }

    // MARK: window

    private func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 780),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Mac Cleaner"
        window.minSize = NSSize(width: 820, height: 520)
        window.center()
        window.setFrameAutosaveName("MacCleanerMain")
        window.titlebarAppearsTransparent = false

        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isHidden = true
        window.contentView!.addSubview(webView)

        status = NSTextField(labelWithString: "Starting the cleaner service…")
        status.alignment = .center
        status.font = NSFont.systemFont(ofSize: 15)
        status.textColor = .secondaryLabelColor
        status.frame = NSRect(x: 0, y: window.contentView!.bounds.midY - 12, width: window.contentView!.bounds.width, height: 24)
        status.autoresizingMask = [.width, .minYMargin, .maxYMargin]
        window.contentView!.addSubview(status)

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Mac Cleaner", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "b")
        appMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        appMenu.addItem(withTitle: "Grant Full Disk Access…", action: #selector(openFullDiskAccess), keyEquivalent: "")
        appMenu.addItem(withTitle: "Show Reports Folder", action: #selector(showReports), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Mac Cleaner", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Mac Cleaner", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let windowItem = NSMenuItem(); main.addItem(windowItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowItem.submenu = win
        NSApp.windowsMenu = win

        NSApp.mainMenu = main
    }

    // MARK: server lifecycle

    private func startServer() {
        guard let exe = Bundle.main.url(forResource: "mac-cleaner-server", withExtension: nil) else {
            fail("The bundled server is missing from the app.")
            return
        }
        let proc = Process()
        proc.executableURL = exe
        proc.arguments = ["serve", "--port", "0"]
        var env = ProcessInfo.processInfo.environment
        env["MAC_CLEANER_UI"] = Bundle.main.url(forResource: "index", withExtension: "html")?.path ?? ""
        env["HOME"] = NSHomeDirectory()
        proc.environment = env
        proc.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())

        let out = Pipe()
        proc.standardOutput = out
        proc.standardError = out
        out.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            NSLog("mac-cleaner-server: %@", text.trimmingCharacters(in: .whitespacesAndNewlines))
            if let range = text.range(of: "http://127.0.0.1:[0-9]+", options: .regularExpression), self?.serverURL == nil {
                let url = URL(string: String(text[range]))!
                DispatchQueue.main.async { self?.serverReady(url) }
            }
        }
        proc.terminationHandler = { [weak self] p in
            DispatchQueue.main.async {
                guard let self = self, self.server === p else { return }
                self.server = nil
                if NSApp.isRunning { self.fail("The cleaner service stopped (exit \(p.terminationStatus)).") }
            }
        }
        do {
            try proc.run()
            server = proc
        } catch {
            fail("Could not start the cleaner service: \(error.localizedDescription)")
        }
    }

    private func stopServer() {
        guard let p = server, p.isRunning else { return }
        server = nil
        p.terminate()
        // Give it a moment, then make sure it is gone.
        DispatchQueue.global().asyncAfter(deadline: .now() + 1.5) { if p.isRunning { kill(p.processIdentifier, SIGKILL) } }
    }

    private func serverReady(_ url: URL) {
        serverURL = url
        status.stringValue = "Loading…"
        webView.load(URLRequest(url: url))
    }

    private func fail(_ message: String) {
        status.stringValue = message
        status.textColor = .systemRed
        webView.isHidden = true
    }

    // MARK: WKNavigationDelegate / WKUIDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        status.isHidden = true
        webView.isHidden = false
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail("Could not load the interface: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        // The server may still be binding; retry a few times.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            if let url = self?.serverURL { self?.webView.load(URLRequest(url: url)) }
        }
    }

    // Links to anything other than our server open in the default browser.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, let base = serverURL, url.host != base.host || url.port != base.port, url.scheme?.hasPrefix("http") == true {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // MARK: actions

    @objc private func openInBrowser() {
        if let url = serverURL { NSWorkspace.shared.open(url) }
    }

    @objc private func reload() {
        if let url = serverURL { webView.load(URLRequest(url: url)) }
    }

    @objc private func openFullDiskAccess() {
        let alert = NSAlert()
        alert.messageText = "Full Disk Access"
        alert.informativeText = "Mail attachments, Safari history, iOS backups and app permissions are only visible when Mac Cleaner has Full Disk Access. System Settings will open; add Mac Cleaner to the list, then quit and reopen the app."
        alert.addButton(withTitle: "Open System Settings")
        alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn {
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!)
        }
    }

    @objc private func showReports() {
        let dir = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".mac-cleaner")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        NSWorkspace.shared.activateFileViewerSelecting([dir])
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
