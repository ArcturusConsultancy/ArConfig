import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";

function key(task) { return task.code || task.name; }

function readStoredState(name, fallback) {
  try {
    const stored = localStorage.getItem(name);
    return stored ? JSON.parse(stored) : fallback;
  } catch {
    return fallback;
  }
}

function useStoredState(name, fallback) {
  const [value, setValue] = useState(() => readStoredState(name, fallback));

  useEffect(() => {
    localStorage.setItem(name, JSON.stringify(value));
  }, [name, value]);

  return [value, setValue];
}

function CompareView({ offerings, addLog, refreshHistory, onOpenSettings }) {
  const [connections, setConnections] = useState([]);
  const [sourceId, setSourceId] = useStoredState("arconfig.compare.sourceId", "");
  const [targetId, setTargetId] = useStoredState("arconfig.compare.targetId", "");
  const [offering, setOffering] = useStoredState("arconfig.compare.offering", null);
  const [areas, setAreas] = useStoredState("arconfig.compare.areas", []);
  const [area, setArea] = useStoredState("arconfig.compare.area", null);
  const [taskSource, setTaskSource] = useStoredState("arconfig.compare.taskSource", "area");
  const [taskSearch, setTaskSearch] = useStoredState("arconfig.compare.taskSearch", "");
  const [tasks, setTasks] = useStoredState("arconfig.compare.tasks", []);
  const [selected, setSelected] = useStoredState("arconfig.compare.selected", []);
  const [orgCodes, setOrgCodes] = useStoredState("arconfig.compare.orgCodes", "");
  const [busy, setBusy] = useState(false);
  const [runKind, setRunKind] = useState("");
  const [message, setMessage] = useState(null);
  const [catalogNote, setCatalogNote] = useState("");
  const [comparison, setComparison] = useState(null);
  const selectedTasks = useMemo(() => tasks.filter((task) => selected.includes(key(task))), [tasks, selected]);

  useEffect(() => {
    axios.get("/api/environments").then((response) => setConnections(response.data.connections || []))
      .catch((error) => setMessage({ type: "error", text: error.response?.data?.error || error.message }));
  }, []);

  const selectOffering = async (event) => {
    const next = event.target.value === "ALL"
      ? { code: "ALL", name: "All Setups" }
      : offerings.find((item) => item.code === event.target.value) || null;
    setOffering(next); setArea(null); setAreas([]); setTasks([]); setSelected([]); setCatalogNote(""); setComparison(null);
    if (!next) return;
    if (next.code === "ALL") return;
    setBusy(true);
    try {
      const response = await axios.post("/api/setup/functional-areas", { offering: next });
      setAreas(response.data.functionalAreas || []);
    } catch (error) { setMessage({ type: "error", text: error.response?.data?.error || error.message }); }
    finally { setBusy(false); }
  };

  const selectArea = async (event) => {
    const next = areas.find((item) => item.code === event.target.value) || null;
    setArea(next); setTasks([]); setSelected([]); setCatalogNote(""); setComparison(null);
    if (!next) return;
    setBusy(true);
    try {
      const response = await axios.post("/api/setup/area-tasks", { functionalAreaCode: next.code, functionalAreaName: next.name });
      const nextTasks = response.data.tasks || [];
      setTasks(nextTasks);
      setSelected(nextTasks.filter((task) => task.available !== false && task.exportSupported).map(key));
      setCatalogNote(response.data.note || "");
    } catch (error) { setMessage({ type: "error", text: error.response?.data?.error || error.message }); }
    finally { setBusy(false); }
  };

  const changeTaskSource = (source) => {
    setTaskSource(source);
    setTasks([]);
    setSelected([]);
    setCatalogNote("");
    setMessage(null);
    setComparison(null);
    if (source === "area" && area) {
      setBusy(true);
      axios.post("/api/setup/area-tasks", { functionalAreaCode: area.code, functionalAreaName: area.name })
        .then((response) => {
          const nextTasks = response.data.tasks || [];
          setTasks(nextTasks);
          setSelected(nextTasks.filter((task) => task.available !== false && task.exportSupported).map(key));
          setCatalogNote(response.data.note || "");
        })
        .catch((error) => setMessage({ type: "error", text: error.response?.data?.error || error.message }))
        .finally(() => setBusy(false));
    }
  };

  const searchTasks = async (event) => {
    event.preventDefault();
    const search = taskSearch.trim();
    if (search.length < 2) {
      setMessage({ type: "error", text: "Enter at least two characters of a task name." });
      return;
    }
    setBusy(true); setMessage(null); setCatalogNote(""); setComparison(null);
    try {
      const response = await axios.post("/api/setup/task-search", { search });
      const results = response.data.tasks || [];
      setTasks((currentTasks) => {
        const selectedKeys = new Set(selected);
        const retainedSelections = currentTasks.filter((task) => selectedKeys.has(key(task)));
        const merged = new Map();
        for (const task of [...retainedSelections, ...results]) merged.set(key(task), task);
        return Array.from(merged.values());
      });
      setCatalogNote(results.length
        ? `Found ${results.length} exact Oracle task definitions matching “${search}”. Previously selected tasks are retained.`
        : `Oracle returned no tasks matching “${search}”.`);
      if (addLog) addLog(`Oracle task search returned ${results.length} results for ${search}.`, "success");
    } catch (error) {
      const text = error.response?.data?.error || error.message;
      setMessage({ type: "error", text: `Could not search Oracle tasks: ${text}` });
      if (addLog) addLog(`Oracle task search failed: ${text}`, "error");
    } finally { setBusy(false); }
  };

  const run = async () => {
    setBusy(true); setRunKind("area"); setMessage(null); setComparison(null);
    try {
      const comparisonArea = taskSource === "search"
        ? { code: "GLOBAL_TASK_SEARCH", name: "All Oracle Setup Tasks" }
        : area;
      const response = await axios.post("/api/comparison/run", {
        sourceConnectionId: sourceId, targetConnectionId: targetId,
        offering: taskSource === "search" ? { code: "ALL", name: "All Setups" } : offering,
        functionalArea: comparisonArea, module: comparisonArea?.name, tasks: selectedTasks, orgCodes,
      });
      setComparison(response.data);
      setMessage({ type: "success", text: "Comparison completed and the Excel report is ready." });
      if (addLog) addLog(`Compared ${selectedTasks.length} configuration items.`, "success");
      if (refreshHistory) refreshHistory();
    } catch (error) {
      const text = error.response?.data?.error || error.message;
      setMessage({ type: "error", text }); if (addLog) addLog(`Comparison failed: ${text}`, "error");
    } finally { setBusy(false); setRunKind(""); }
  };

  const runComplete = async () => {
    setBusy(true); setRunKind("complete"); setMessage(null); setComparison(null);
    try {
      const response = await axios.post("/api/comparison/complete-setup", {
        sourceConnectionId: sourceId,
        targetConnectionId: targetId,
        offering,
        orgCodes,
      });
      setComparison(response.data);
      const scope = offering?.code === "ALL" ? "all setups" : offering?.name;
      const succeeded = response.data.run?.status === "success";
      setMessage({ type: succeeded ? "success" : "error", text: `Complete comparison for ${scope} finished with status ${response.data.run?.status || "unknown"}. The ZIP report is ready.` });
      if (addLog) addLog(`Complete comparison finished for ${scope} (${response.data.run?.status || "unknown"}).`, succeeded ? "success" : "error");
      if (refreshHistory) refreshHistory();
    } catch (error) {
      const text = error.response?.data?.error || error.message;
      setMessage({ type: "error", text });
      if (addLog) addLog(`Complete comparison failed: ${text}`, "error");
    } finally { setBusy(false); setRunKind(""); }
  };

  const download = async () => {
    const response = await axios.get(comparison.downloadUrl, { responseType: "blob" });
    const url = window.URL.createObjectURL(response.data); const link = document.createElement("a");
    link.href = url; link.download = comparison.run.outputFile; document.body.appendChild(link); link.click(); link.remove(); window.URL.revokeObjectURL(url);
  };

  const summary = comparison?.summary;
  const detailedRows = (comparison?.results || []).flatMap((result) => result.status === "MODIFIED"
    ? result.changes.map((change) => ({ ...change, recordKey: result.recordKey, configurationName: result.configurationName, dataset: result.dataset, status: result.status }))
    : [{ recordKey: result.recordKey, configurationName: result.configurationName, dataset: result.dataset, status: result.status, field: "", sourceValue: "", targetValue: "" }]);

  return (
    <>
      <div className="page-heading"><h1>Config Compare</h1><p>Extract the same configuration from two saved Oracle environments and compare it by stable business keys.</p></div>
      <section className="panel-card">
        <div className="configuration-heading"><h2>Comparison Configuration</h2><div className="source-switch"><button type="button" className={taskSource === "area" ? "" : "outline-button"} onClick={() => changeTaskSource("area")} disabled={busy}>Browse Functional Areas</button><button type="button" className={taskSource === "search" ? "" : "outline-button"} onClick={() => changeTaskSource("search")} disabled={busy}>Search All Tasks</button></div></div>
        {connections.length < 2 && (
          <div className="catalog-note compare-empty-state">
            <p>Comparison needs at least two saved Oracle environments. Save DEV, SIT, UAT, or PROD in Settings first, then come back here.</p>
            {onOpenSettings && <button type="button" className="outline-button compact-button" onClick={onOpenSettings}>Open Settings</button>}
          </div>
        )}
        <div className="compare-environments">
          <label>Source Environment<select value={sourceId} onChange={(event) => setSourceId(event.target.value)} disabled={connections.length === 0}><option value="">{connections.length ? "Select source" : "No saved environments"}</option>{connections.map((item) => <option value={item._id} key={item._id}>{item.name} ({item.environmentType})</option>)}</select></label>
          <strong>VS</strong>
          <label>Target Environment<select value={targetId} onChange={(event) => setTargetId(event.target.value)} disabled={connections.length === 0}><option value="">{connections.length ? "Select target" : "No saved environments"}</option>{connections.map((item) => <option value={item._id} key={item._id}>{item.name} ({item.environmentType})</option>)}</select></label>
        </div>
        {taskSource === "area" ? (
          <div className="selection-grid compare-selection">
            <label>Setup<select value={offering?.code || ""} onChange={selectOffering}><option value="">Select setup</option><option value="ALL">All Setups</option>{offerings.map((item) => <option value={item.code} key={item.code}>{item.name}</option>)}</select></label>
            <label>Functional Area / Module<select value={area?.code || ""} onChange={selectArea} disabled={!offering || offering.code === "ALL"}><option value="">{offering?.code === "ALL" ? "All functional areas" : "Select area"}</option>{areas.map((item) => <option value={item.code} key={item.code}>{item.name}</option>)}</select></label>
            <label>Business Unit / Scope<input value={orgCodes} onChange={(event) => setOrgCodes(event.target.value)} placeholder="ALL or M1" /></label>
          </div>
        ) : (
          <><form className="task-search-form" onSubmit={searchTasks}><label htmlFor="compare-task-search">Oracle task name<input id="compare-task-search" value={taskSearch} onChange={(event) => setTaskSearch(event.target.value)} placeholder="For example: Manage Business Unit" disabled={busy} autoFocus /></label><button type="submit" disabled={busy || taskSearch.trim().length < 2}>{busy ? "Searching..." : "Search Oracle"}</button></form><div className="field-group scope-field"><label>Business Unit / Scope<input value={orgCodes} onChange={(event) => setOrgCodes(event.target.value)} placeholder="ALL or M1" disabled={busy} /></label></div></>
        )}
        {taskSource === "area" && offering && <p className="catalog-note"><strong>Complete comparison:</strong> compare every exportable task in every functional area and download a ZIP containing one Excel report per functional area. All Setups includes every setup folder.</p>}
        {catalogNote && <p className="catalog-note">{catalogNote}</p>}
        <div className="task-heading"><div><h2>Configuration Items</h2><p>{selectedTasks.length} of {tasks.length} selected</p></div><div className="task-heading-actions"><button type="button" className="outline-button compact-button" onClick={() => setSelected([])} disabled={busy || !selected.length}>Clear Selection</button><button type="button" className="outline-button compact-button" onClick={() => setSelected(tasks.filter((task) => task.available !== false && task.exportSupported).map(key))} disabled={busy || !tasks.length}>Select Exportable</button></div></div>
        <div className="task-list compare-task-list">{tasks.map((task) => { const enabled = task.available !== false && task.exportSupported; return <label className={`task-option ${enabled ? "" : "task-disabled"}`} key={key(task)}><input type="checkbox" checked={selected.includes(key(task))} disabled={!enabled || busy} onChange={() => setSelected((current) => current.includes(key(task)) ? current.filter((item) => item !== key(task)) : [...current, key(task)])} /><span><strong>{task.name}</strong></span></label>; })}{!tasks.length && <p className="empty-state">{taskSource === "search" ? "Search Oracle by task name to load exact task definitions." : "Select a setup and functional area to load configuration items."}</p>}</div>
        <div className="button-row compare-actions"><button onClick={run} disabled={busy || !sourceId || !targetId || sourceId === targetId || !selectedTasks.length}>{busy && runKind === "area" ? "Comparing..." : "Run Selected Comparison"}</button>{taskSource === "area" && <button onClick={runComplete} disabled={busy || !sourceId || !targetId || sourceId === targetId || !offering}>{busy && runKind === "complete" ? "Comparing Complete Scope..." : offering?.code === "ALL" ? "Compare All Setups" : "Compare Complete Setup"}</button>}{comparison && <button className="outline-button" onClick={download}>{comparison.completeScope ? "Download Comparison ZIP" : "Download Excel Report"}</button>}</div>
        {message && <p className={message.type === "success" ? "status-ok" : "status-fail"}>{message.text}</p>}
      </section>
      {summary && <>
        <section className="comparison-summary">{[["Modified", summary.modified], ["Added", summary.added], ["Removed", summary.removed], ["Unchanged", summary.unchanged], ["Warnings", summary.warnings]].map(([label, value]) => <article className={`summary-${label.toLowerCase()}`} key={label}><span>{label}</span><strong>{value}</strong></article>)}</section>
        <section className="panel-card"><h2>Field-level Results</h2>{comparison.truncated && <p className="catalog-note">The browser view is limited to 5,000 records. The workbook contains the complete comparison.</p>}<div className="history-wrap"><table className="history-table comparison-table"><thead><tr><th>Configuration</th><th>Dataset</th><th>Record Key</th><th>Status</th><th>Field</th><th>Source</th><th>Target</th></tr></thead><tbody>{detailedRows.slice(0, 1000).map((row, index) => <tr key={`${row.configurationName}-${row.recordKey}-${row.field}-${index}`}><td>{row.configurationName}</td><td>{row.dataset}</td><td>{row.recordKey}</td><td><span className={`diff-status diff-${row.status.toLowerCase()}`}>{row.status}</span></td><td>{row.field || "—"}</td><td>{String(row.sourceValue ?? "")}</td><td>{String(row.targetValue ?? "")}</td></tr>)}</tbody></table></div></section>
      </>}
    </>
  );
}

export default CompareView;
