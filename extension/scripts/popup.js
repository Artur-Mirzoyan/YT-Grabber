const $ = (id) => document.getElementById(id);
const goBtn = $("go");
let videoUrl = null;

function isVideoUrl(u) {
    try {
        const url = new URL(u);
        const yt = /(^|\.)youtube\.com$/.test(url.hostname);
        return (
            (yt && url.pathname === "/watch" && url.searchParams.has("v")) ||
            (yt && url.pathname.startsWith("/shorts/")) ||
            url.hostname === "youtu.be"
        );
    } catch {
        return false;
    }
}

function render(status) {
    const working = status?.state === "working";
    const pct = typeof status?.percent === "number" ? Math.round(status.percent) : null;

    $("status").textContent = status ? status.message + (working && pct !== null ? ` ${pct}%` : "") : "";
    $("status").dataset.state = status?.state ?? "";

    // Progress bar: visible while working (and briefly full when done).
    const bar = $("bar");
    bar.hidden = !(working || status?.state === "done");
    bar.classList.toggle("indeterminate", working && (pct === null || pct <= 0));
    $("fill").style.width = pct !== null ? `${pct}%` : "";
    if (pct !== null) bar.setAttribute("aria-valuenow", String(pct));
    else bar.removeAttribute("aria-valuenow");

    goBtn.disabled = !videoUrl || working;
}

async function init() {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (tab && isVideoUrl(tab.url)) {
        videoUrl = tab.url;
        $("title").textContent = tab.title.replace(/ - YouTube$/, "");
    }
    const {status} = await chrome.storage.session.get("status");
    const age = status ? Date.now() - status.at : Infinity;
    // Ignore old results, and "working" states nobody has updated for 15s (stalled worker).
    const fresh = status && age < 5 * 60 * 1000 && !(status.state === "working" && age > 15000);
    render(fresh ? status : null);
}

goBtn.addEventListener("click", () => {
    const format = document.querySelector('input[name="format"]:checked').value;
    chrome.runtime.sendMessage({type: "download", url: videoUrl, format});
    render({state: "working", message: "Starting", percent: 0});
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.status) render(changes.status.newValue);
});

$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

init();
