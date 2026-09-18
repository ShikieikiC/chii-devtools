const chii = require("chii");
const path = require("path");
const net = require("net");
const http = require("http");
const zlib = require("zlib");
const { BrowserWindow, ipcMain, session } = require("electron");
const { slug } = require("../manifest.json");


const data_path = path.join(LiteLoader.path.data, slug);


// 直接向本地 chii 服务发请求，不走系统代理。
// 若环境存在 ALL_PROXY / HTTP_PROXY（常见于开启代理软件时），
// Electron 的 net.fetch 会把 localhost 请求也交给代理，
// 代理拒绝转发本地地址并返回 503，导致读取 /targets 失败、F12 无反应。
function httpGetJson(url) {
    return new Promise((resolve, reject) => {
        // 显式声明不接受压缩：Node 的 http 模块不会自动解压，
        // 若服务端返回 gzip 内容会被当作 UTF-8 解码成乱码，导致 JSON 解析失败。
        const req = http.get(url, { agent: false, headers: { "Accept-Encoding": "identity" } }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
                return;
            }
            const chunks = [];
            const stream = res.headers["content-encoding"] === "gzip" ? res.pipe(zlib.createGunzip()) : res;
            stream.on("data", (c) => chunks.push(c));
            stream.on("error", (e) => reject(new Error(`解压失败: ${e.message}`)));
            stream.on("end", () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8"))); }
                catch (e) { reject(new Error(`JSON 解析失败: ${e.message}`)); }
            });
        });
        req.on("error", reject);
        req.setTimeout(5000, () => req.destroy(new Error("请求超时")));
    });
}


// 获取空闲端口号
const port = (() => {
    const server = net.createServer().listen(0);
    const { port } = server.address();
    return server.close() && port;
})();


// 启动chii服务器
chii.start({ port });


// 把端口传给渲染进程
ipcMain.handle("mojinran.chii_devtools.ready", () => port);


// 比较 target 与窗口 URL 时忽略 hash。
// QQ 启动时先加载 #/blank 完成 target 注册，随后路由跳转到 #/main/message，
// 但 chii 中记录的仍是注册时的 URL，hash 不同会导致严格比对永远失败。
function samePage(a, b) {
    if (!a || !b) return false;
    const strip = (u) => {
        const i = u.indexOf("#");
        return i === -1 ? u : u.slice(0, i);
    };
    return strip(a) === strip(b);
}

// 打开DevTools
async function openDevTools(window) {
    const current_url = window.webContents.getURL();
    const targets_url = `http://localhost:${port}/targets`;
    const targets = await httpGetJson(targets_url);
    const target_list = Array.isArray(targets.targets) ? targets.targets : [];

    for (const target of [...target_list].reverse()) {
        if (!samePage(target.url, current_url)) continue;
        const devtools_params = `?ws=localhost:${port}/client/LiteLoader?target=${target.id}`;
        const devtools_url = `http://localhost:${port}/front_end/chii_app.html${devtools_params}`;
        const devtools_session = session.fromPath(data_path);
        // 同样绕过系统代理，否则 DevTools 窗口自身也加载不出来
        try { await devtools_session.setProxy({ mode: "direct" }); } catch (e) { }
        const devtools_window = new BrowserWindow({
            autoHideMenuBar: true,
            webPreferences: {
                session: devtools_session
            }
        });
        try {
            await devtools_window.loadURL(devtools_url);
            return devtools_window;
        }
        catch (error) {
            devtools_window.destroy();
            throw error;
        }
    }
}


// 创建窗口时触发
exports.onBrowserWindowCreated = (window) => {
    let devtools_window = null;
    let opening = false;
    window.webContents.on("before-input-event", async (_event, input) => {
        if ((input.key == "F12" || (
            input.key == "I" && (process.platform === "darwin" ? input.meta : input.control) && input.shift)
        ) && input.type == "keyUp") {
            if (devtools_window?.isDestroyed()) {
                devtools_window = null;
            }

            if (devtools_window) {
                devtools_window.close();
                devtools_window = null;
                return;
            }
            if (opening) return;

            opening = true;
            try {
                devtools_window = await openDevTools(window);
                devtools_window?.on("closed", () => devtools_window = null);
            }
            catch (error) {
                console.error("[Chii DevTools] Failed to open DevTools:", error);
                // 明示失败原因，避免"按 F12 毫无反应"
                const { dialog } = require("electron");
                const message = error?.message ?? String(error);
                dialog.showMessageBox({ type: "error", title: "Chii DevTools", message: "打开 DevTools 失败", detail: message });
            }
            finally {
                opening = false;
            }
        }
    });
};
