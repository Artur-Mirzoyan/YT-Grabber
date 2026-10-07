const DEFAULT_SERVER = "http://127.0.0.1:5000";
const $ = (id) => document.getElementById(id);

const say = (text, state = "") => {
    $("msg").textContent = text;
    $("msg").dataset.state = state;
};

function normalize(raw) {
    const u = new URL((raw || DEFAULT_SERVER).trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Address must start with http:// or https://");
    return u.origin + u.pathname.replace(/\/+$/, "");
}

// Ask Chrome for access to this one server (needed for any address other than localhost:5000).
async function ensureAccess(server) {
    const origin = new URL(server).origin + "/*";
    if (await chrome.permissions.contains({origins: [origin]})) return true;
    return chrome.permissions.request({origins: [origin]}); // must run inside a click handler
}

async function save() {
    const server = normalize($("serverUrl").value);
    if (!(await ensureAccess(server))) throw new Error("Permission to reach that server was not granted.");
    await chrome.storage.local.set({serverUrl: server, apiKey: $("apiKey").value.trim()});
    $("serverUrl").value = server;
    return server;
}

$("save").addEventListener("click", async () => {
    try {
        await save();
        say("Saved.", "ok");
    } catch (e) {
        say(e.message, "error");
    }
});

$("test").addEventListener("click", async () => {
    try {
        const server = await save();
        const key = $("apiKey").value.trim();
        const res = await fetch(`${server}/api/health`, {headers: key ? {"X-API-Key": key} : {}});
        if (res.status === 401) throw new Error("The server rejected the API key.");
        const data = await res.json();
        if (!data.ok) throw new Error("Unexpected reply from server.");
        say(data.ffmpeg ? "Connected. Server is ready." : "Connected, but ffmpeg is missing on the server (MP3 and MP4 will fail).",
            data.ffmpeg ? "ok" : "error");
    } catch (e) {
        say(e instanceof TypeError ? "Couldn't reach the server. Is it running?" : e.message, "error");
    }
});

(async () => {
    const {serverUrl, apiKey} = await chrome.storage.local.get(["serverUrl", "apiKey"]);
    $("serverUrl").value = serverUrl || DEFAULT_SERVER;
    $("apiKey").value = apiKey || "";
})();
