// Runs the request in the service worker so it survives the popup closing.
const DEFAULT_SERVER = "http://127.0.0.1:5000";

// percent: 0-100, or null when unknown. Each write also keeps the service worker alive.
const setStatus = (state, message, percent = null) =>
    chrome.storage.session.set({status: {state, message, percent, at: Date.now()}});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getSettings() {
    const {serverUrl, apiKey} = await chrome.storage.local.get(["serverUrl", "apiKey"]);
    return {server: (serverUrl || DEFAULT_SERVER).replace(/\/+$/, ""), apiKey: apiKey || ""};
}

async function handleDownload({url, format}) {
    await setStatus("working", "Starting", 0);
    try {
        const {server, apiKey} = await getSettings();
        const headers = {"Content-Type": "application/json"};
        if (apiKey) headers["X-API-Key"] = apiKey;

        const res = await fetch(`${server}/api/convert`, {
            method: "POST",
            headers,
            body: JSON.stringify({url, format}),
        });
        const started = await res.json();
        if (!res.ok) throw new Error(started.error || `Server error ${res.status}`);

        // Poll the job once a second (up to 30 minutes).
        let job;
        for (let i = 0; i < 1800; i++) {
            await sleep(1000);
            const r = await fetch(`${server}/api/status/${started.job_id}`, {headers});
            job = await r.json();
            if (!r.ok) throw new Error(job.error || `Server error ${r.status}`);
            if (job.state === "error") throw new Error(job.error);
            if (job.state === "done") break;
            await setStatus("working", job.stage, job.percent);
        }
        if (job?.state !== "done") throw new Error("Timed out waiting for the server.");

        // Chrome streams the file straight to disk (no big blob held in memory).
        await chrome.downloads.download({url: `${server}/api/file/${started.job_id}`});
        await setStatus("done", `Saved: ${job.filename}`, 100);
    } catch (err) {
        const offline = err instanceof TypeError;
        await setStatus(
            "error",
            offline
                ? "Can't reach your server. Check that it's running and the address in Server settings is right."
                : err.message
        );
    }
}

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "download") handleDownload(msg);
});
