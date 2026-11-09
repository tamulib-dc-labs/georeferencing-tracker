let statusData = null;
let currentFilter = "all";

const app = document.getElementById("app");
const summaryEl = document.getElementById("summary");
const generatedAtEl = document.getElementById("generatedAt");

function canvasState(canvas) {
  if (canvas.georeferenced) return "done";
  if (canvas.hasMap === true) return "todo";
  if (canvas.hasMap === false) return "not-applicable";
  return "unreviewed";
}

const STATE_LABEL = {
  done: "Done",
  todo: "Todo",
  "not-applicable": "Not a map",
  unreviewed: "Unreviewed",
};

function allCanvases() {
  const out = [];
  for (const collection of statusData.collections || []) {
    for (const manifest of collection.manifests || []) {
      for (const canvas of manifest.canvases || []) {
        out.push({ collection, manifest, canvas });
      }
    }
  }
  return out;
}

function allManifests() {
  const out = [];
  for (const collection of statusData.collections || []) {
    for (const manifest of collection.manifests || []) out.push(manifest);
  }
  return out;
}

function renderSummary() {
  const counts = { done: 0, todo: 0, "not-applicable": 0, unreviewed: 0 };
  for (const { canvas } of allCanvases()) counts[canvasState(canvas)]++;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const incompleteManifests = allManifests().filter((m) => m.incomplete).length;
  const incompleteBadge = incompleteManifests
    ? ` <span class="badge incomplete" title="Compound objects whose canvas list couldn't be fetched automatically — see README">⚠ ${incompleteManifests} manifests incomplete</span>`
    : "";
  summaryEl.innerHTML = Object.entries(counts)
    .map(
      ([state, n]) =>
        `<span class="badge ${state}">${STATE_LABEL[state]}: ${n}</span>`
    )
    .join(" ") + ` <span>(${total} canvases total)</span>` + incompleteBadge;
}

function manifestProgress(manifest) {
  const canvases = manifest.canvases || [];
  const relevant = canvases.filter((c) => c.hasMap !== false);
  const done = relevant.filter((c) => c.georeferenced).length;
  return `${done} / ${relevant.length} georeferenced` + (canvases.length !== relevant.length ? ` (${canvases.length - relevant.length} not a map)` : "");
}

function render() {
  if (!statusData) {
    app.innerHTML = "<p>No data loaded. Use the controls above to load data/status.json or a file.</p>";
    return;
  }

  generatedAtEl.textContent = statusData.generatedAt ? `Generated: ${statusData.generatedAt}` : "";
  renderSummary();

  app.innerHTML = "";
  for (const collection of statusData.collections || []) {
    const collEl = document.createElement("section");
    collEl.className = "collection";
    collEl.innerHTML = `<h2>${collection.label || collection.id}</h2>`;

    for (const manifest of collection.manifests || []) {
      const visibleCanvases = (manifest.canvases || []).filter(
        (c) => currentFilter === "all" || canvasState(c) === currentFilter
      );
      if (currentFilter !== "all" && visibleCanvases.length === 0) continue;

      const details = document.createElement("details");
      details.className = "manifest";
      details.open = currentFilter !== "all";

      const summary = document.createElement("summary");
      const incompleteBadge = manifest.incomplete
        ? `<span class="badge incomplete" title="Canvas list could not be fetched automatically (compound object behind a bot check) — see README">⚠ incomplete</span> `
        : "";
      summary.innerHTML = `<span>${incompleteBadge}${manifest.label || manifest.id}</span><span class="manifest-progress">${manifestProgress(manifest)}</span>`;
      details.appendChild(summary);

      const table = document.createElement("table");
      table.innerHTML = `
        <thead><tr>
          <th>Thumbnail</th><th>Canvas</th><th>Status</th><th>Has map?</th><th>Notes</th>
        </tr></thead>`;
      const tbody = document.createElement("tbody");

      for (const canvas of visibleCanvases) {
        const tr = document.createElement("tr");
        const state = canvasState(canvas);
        tr.innerHTML = `
          <td>${canvas.thumbnail ? `<img class="thumb" src="${canvas.thumbnail}" loading="lazy" alt="" />` : ""}</td>
          <td><a href="${canvas.id}" target="_blank" rel="noopener">${canvas.label || canvas.id}</a></td>
          <td><span class="badge ${state}">${STATE_LABEL[state]}</span></td>
          <td>
            <select class="hasMap">
              <option value="null">Unreviewed</option>
              <option value="true">Yes, has a map</option>
              <option value="false">No</option>
            </select>
          </td>
          <td><input class="notes" type="text" value="${(canvas.notes || "").replace(/"/g, "&quot;")}" /></td>
        `;
        const select = tr.querySelector("select.hasMap");
        select.value = String(canvas.hasMap);
        select.addEventListener("change", () => {
          canvas.hasMap = select.value === "null" ? null : select.value === "true";
          render();
        });
        tr.querySelector("input.notes").addEventListener("input", (e) => {
          canvas.notes = e.target.value;
        });
        tbody.appendChild(tr);
      }

      table.appendChild(tbody);
      details.appendChild(table);
      collEl.appendChild(details);
    }
    app.appendChild(collEl);
  }
}

async function loadFromUrl(url) {
  const res = await fetch(url);
  statusData = await res.json();
  render();
}

document.getElementById("loadDefault").addEventListener("click", () => {
  loadFromUrl("../data/status.json").catch((err) => {
    alert(`Could not load ../data/status.json (${err.message}). Try data/status.example.json instead, or use the file picker.`);
  });
});

document.getElementById("fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  statusData = JSON.parse(await file.text());
  render();
});

document.getElementById("filter").addEventListener("change", (e) => {
  currentFilter = e.target.value;
  render();
});

document.getElementById("downloadBtn").addEventListener("click", () => {
  if (!statusData) return;
  const blob = new Blob([JSON.stringify(statusData, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "status.json";
  a.click();
});

// Try loading the real data on first open; fall back silently.
loadFromUrl("../data/status.json").catch(() => {
  loadFromUrl("../data/status.example.json").catch(() => render());
});
