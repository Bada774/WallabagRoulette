const query = matchMedia("(prefers-color-scheme: dark)");

function report() {
    chrome.runtime
        .sendMessage({ type: "toolbar-theme", dark: query.matches })
        .catch(() => {});
}

query.addEventListener("change", report);
report();
