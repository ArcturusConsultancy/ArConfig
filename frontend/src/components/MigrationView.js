import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";

function key(task) { return task.code || task.name; }

function count(plan, name) {
  return plan?.summary?.[name] || 0;
}

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

function MigrationView({ offerings, addLog, refreshHistory, onOpenSettings }) {
  const [connections, setConnections] = useState([]);
  const [sources, setSources] = useState([]);
  const [sourceType, setSourceType] = useStoredState("arconfig.migration.sourceType", "EXTRACTION");
  const [sourceRunId, setSourceRunId] = useStoredState("arconfig.migration.sourceRunId", "");
  const [workbook, setWorkbook] = useState(null);
  const [destinationId, setDestinationId] = useStoredState("arconfig.migration.destinationId", "");
  const [offering, setOffering] = useStoredState("arconfig.migration.offering", null);
  const [areas, setAreas] = useStoredState("arconfig.migration.areas", []);
  const [area, setArea] = useStoredState("arconfig.migration.area", null);
  const [taskSource, setTaskSource] = useStoredState("arconfig.migration.taskSource", "area");
  const [taskSearch, setTaskSearch] = useStoredState("arconfig.migration.taskSearch", "");
  const [tasks, setTasks] = useStoredState("arconfig.migration.tasks", []);
  const [selected, setSelected] = useStoredState("arconfig.migration.selected", []);
  const [orgCodes, setOrgCodes] = useStoredState("arconfig.migration.orgCodes", "");
  const [allowRevisionMismatch, setAllowRevisionMismatch] = useStoredState("arconfig.migration.allowRevisionMismatch", false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [catalogNote, setCatalogNote] = useState("");
  const [plan, setPlan] = useState(null);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [confirmationText, setConfirmationText] = useState("");
  const [executionProgress, setExecutionProgress] = useState(null);

  const selectedTasks = useMemo(() => tasks.filter((task) => selected.includes(key(task))), [tasks, selected]);
  const destination = connections.find((item) => item._id === destinationId);
  const isProductionDestination = String(destination?.environmentType || "").toUpperCase() === "PROD";
  const exactConfirmation = destination ? `MIGRATE TO ${destination.name}` : "";
  const blockers = plan?.blockingErrors || [];
  const warnings = plan?.warnings || [];
  const previewRows = (plan?.operations || []).slice(0, 600);
  const actionCount = count(plan, "create") + count(plan, "update");
  const noChanges = Boolean(plan && !blockers.length && actionCount === 0);

  useEffect(() => {
    axios.get("/api/environments").then((response) => setConnections(response.data.connections || []))
      .catch((error) => setMessage({ type: "error", text: error.response?.data?.error || error.message }));
    axios.get("/api/migration/sources").then((response) => setSources(response.data.sources || []))
      .catch(() => setSources([]));
  }, []);

  useEffect(() => {
    if (isProductionDestination && allowRevisionMismatch) setAllowRevisionMismatch(false);
  }, [allowRevisionMismatch, isProductionDestination, setAllowRevisionMismatch]);

  const selectOffering = async (event) => {
    const next = offerings.find((item) => item.code === event.target.value) || null;
    setOffering(next); setArea(null); setAreas([]); setTasks([]); setSelected([]); setCatalogNote(""); setPlan(null); setDownloadUrl("");
    if (!next) return;
    setBusy(true);
    try {
      const response = await axios.post("/api/setup/functional-areas", { offering: next });
      setAreas(response.data.functionalAreas || []);
    } catch (error) { setMessage({ type: "error", text: error.response?.data?.error || error.message }); }
    finally { setBusy(false); }
  };

  const selectArea = async (event) => {
    const next = areas.find((item) => item.code === event.target.value) || null;
    setArea(next); setTasks([]); setSelected([]); setCatalogNote(""); setPlan(null); setDownloadUrl("");
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
    setPlan(null);
    setDownloadUrl("");
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
    setBusy(true); setMessage(null); setCatalogNote(""); setPlan(null); setDownloadUrl("");
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

  const validate = async () => {
    setBusy(true); setMessage(null); setPlan(null); setDownloadUrl(""); setConfirmationText("");
    const migrationArea = taskSource === "search"
      ? { code: "GLOBAL_TASK_SEARCH", name: "All Oracle Setup Tasks" }
      : area;
    const payload = {
      sourceRunId,
      destinationConnectionId: destinationId,
      offering: taskSource === "search" ? { code: "ALL", name: "All Setups" } : offering,
      functionalArea: migrationArea,
      module: migrationArea?.name,
      tasks: selectedTasks,
      orgCodes,
      allowRevisionMismatch: allowRevisionMismatch && !isProductionDestination,
    };
    try {
      let response;
      if (sourceType === "WORKBOOK") {
        response = await axios.post("/api/migration/workbook/validate", workbook, {
          headers: {
            "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "x-file-name": workbook?.name || "uploaded.xlsx",
            "x-migration-options": JSON.stringify(payload),
          },
        });
      } else {
        response = await axios.post("/api/migration/validate", payload);
      }
      setPlan(response.data.plan);
      setDownloadUrl(response.data.downloadUrl || "");
      const blocked = response.data.plan?.blockingErrors?.length || 0;
      setMessage({
        type: blocked ? "error" : "success",
        text: blocked
          ? `Validation completed with ${blocked} blocking issue(s). Review Oracle import support and use an Automation ready extraction.`
          : response.data.plan?.status === "COMPLETED"
            ? "Validation completed. Source and destination already match; no migration is required."
            : "Migration plan is ready for confirmation.",
      });
      if (addLog) addLog(`Migration preview created for ${selectedTasks.length} configuration items.`, blocked ? "error" : "success");
      if (refreshHistory) refreshHistory();
    } catch (error) {
      const text = error.response?.data?.error || error.message;
      setMessage({ type: "error", text });
      if (addLog) addLog(`Migration validation failed: ${text}`, "error");
    } finally { setBusy(false); }
  };

  const execute = async () => {
    if (!plan) return;
    setBusy(true);
    setExecutionProgress(null);
    setMessage({ type: "info", text: "Migration submitted. Waiting for Oracle; this application monitors the import for up to 10 minutes." });
    const pollProgress = async () => {
      try {
        const progressResponse = await axios.get(`/api/migration/progress/${plan._id}`);
        setExecutionProgress(progressResponse.data);
      } catch {
        // Progress is created immediately after execution starts; ignore an early 404.
      }
    };
    const progressTimer = window.setInterval(pollProgress, 2000);
    try {
      const response = await axios.post(`/api/migration/plans/${plan._id}/execute`, { confirmationText });
      const executedPlan = response.data.plan;
      setPlan(executedPlan);
      setDownloadUrl(response.data.downloadUrl || "");
      const failedResult = (executedPlan?.executionResults || []).find((item) => item.status === "FAILED");
      const succeeded = executedPlan?.status === "COMPLETED" && !failedResult;
      setMessage({
        type: succeeded ? "success" : "error",
        text: succeeded
          ? "Migration completed successfully in Oracle. Download the report for details."
          : `Migration did not complete successfully. ${failedResult?.errorMessage || `Final status: ${executedPlan?.status || "FAILED"}.`} Download the report for details.`,
      });
      if (refreshHistory) refreshHistory();
    } catch (error) {
      const text = error.response?.data?.error || error.message;
      setMessage({ type: "error", text });
      if (addLog) addLog(`Migration execution blocked: ${text}`, "error");
    } finally {
      window.clearInterval(progressTimer);
      await pollProgress();
      setBusy(false);
    }
  };

  const download = async () => {
    const response = await axios.get(downloadUrl, { responseType: "blob" });
    const url = window.URL.createObjectURL(response.data);
    const link = document.createElement("a");
    link.href = url;
    link.download = plan?.reportFile || "ConfigMigration.xlsx";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  };

  const canValidate = destinationId && selectedTasks.length && (sourceType === "WORKBOOK" ? workbook : sourceRunId);
  const canExecute = plan?.status === "READY" && !blockers.length && confirmationText === exactConfirmation;

  return (
    <>
      <div className="page-heading">
        <h1>Config Migration</h1>
        <p>Validate an automation-ready extraction against a destination environment, preview changes, and import supported Oracle setup-task packages.</p>
      </div>
      <section className="panel-card">
        <div className="configuration-heading"><h2>Config Migration Setup</h2><div className="source-switch"><button type="button" className={taskSource === "area" ? "" : "outline-button"} onClick={() => changeTaskSource("area")} disabled={busy}>Browse Functional Areas</button><button type="button" className={taskSource === "search" ? "" : "outline-button"} onClick={() => changeTaskSource("search")} disabled={busy}>Search All Tasks</button></div></div>
        {connections.length === 0 && (
          <div className="catalog-note compare-empty-state">
            <p>Migration needs at least one saved destination environment in Settings.</p>
            {onOpenSettings && <button type="button" className="outline-button compact-button" onClick={onOpenSettings}>Open Settings</button>}
          </div>
        )}
        <div className="source-switch migration-source-switch">
          <button type="button" className={sourceType === "EXTRACTION" ? "" : "outline-button"} onClick={() => { setSourceType("EXTRACTION"); setPlan(null); }}>Existing Extraction</button>
          <button type="button" className={sourceType === "WORKBOOK" ? "" : "outline-button"} onClick={() => { setSourceType("WORKBOOK"); setPlan(null); }}>Upload Workbook</button>
        </div>
        <div className="compare-environments">
          <label>Source Configuration
            {sourceType === "EXTRACTION" ? (
              <select value={sourceRunId} onChange={(event) => setSourceRunId(event.target.value)}>
                <option value="">{sources.length ? "Select extraction workbook" : "No extraction workbooks found"}</option>
                {sources.map((item) => <option value={item.id} key={item.id}>{item.label} · {item.automatedImportReady ? "Automation ready" : "Preview only — rerun snapshot"}</option>)}
              </select>
            ) : (
              <input type="file" accept=".xlsx" onChange={(event) => setWorkbook(event.target.files?.[0] || null)} />
            )}
          </label>
          <strong>TO</strong>
          <label>Destination Environment
            <select value={destinationId} onChange={(event) => setDestinationId(event.target.value)}>
              <option value="">{connections.length ? "Select destination" : "No saved environments"}</option>
              {connections.map((item) => <option value={item._id} key={item._id}>{item.name} ({item.environmentType})</option>)}
            </select>
          </label>
        </div>
        {taskSource === "area" ? (
          <div className="selection-grid compare-selection">
            <label>Setup<select value={offering?.code || ""} onChange={selectOffering}><option value="">Select setup</option>{offerings.map((item) => <option value={item.code} key={item.code}>{item.name}</option>)}</select></label>
            <label>Functional Area / Module<select value={area?.code || ""} onChange={selectArea} disabled={!offering}><option value="">Select area</option>{areas.map((item) => <option value={item.code} key={item.code}>{item.name}</option>)}</select></label>
            <label>Business Unit / Scope<input value={orgCodes} onChange={(event) => setOrgCodes(event.target.value)} placeholder="ALL or M1" /></label>
          </div>
        ) : (
          <><form className="task-search-form" onSubmit={searchTasks}><label htmlFor="migration-task-search">Oracle task name<input id="migration-task-search" value={taskSearch} onChange={(event) => setTaskSearch(event.target.value)} placeholder="For example: Manage Business Unit" disabled={busy} autoFocus /></label><button type="submit" disabled={busy || taskSearch.trim().length < 2}>{busy ? "Searching..." : "Search Oracle"}</button></form><p className="helper-text">For Existing Extraction, select a snapshot that contains the searched task and its original Oracle package.</p><div className="field-group scope-field"><label>Business Unit / Scope<input value={orgCodes} onChange={(event) => setOrgCodes(event.target.value)} placeholder="ALL or M1" disabled={busy} /></label></div></>
        )}
        {catalogNote && <p className="catalog-note">{catalogNote}</p>}
        <label className={`task-option migration-revision-option ${isProductionDestination ? "task-disabled" : ""}`}>
          <input
            type="checkbox"
            checked={allowRevisionMismatch}
            disabled={!destinationId || isProductionDestination || busy}
            onChange={(event) => { setAllowRevisionMismatch(event.target.checked); setPlan(null); setDownloadUrl(""); }}
          />
          <span>
            <strong>Allow Oracle revision mismatch (non-production only)</strong>
            <small>Allows revision override and, if destination preview export is stuck, a guarded task-package import. Non-production only.</small>
          </span>
        </label>
        <div className="task-heading"><div><h2>Configuration Items</h2><p>{selectedTasks.length} of {tasks.length} selected</p></div><div className="task-heading-actions"><button type="button" className="outline-button compact-button" onClick={() => setSelected([])} disabled={busy || !selected.length}>Clear Selection</button><button type="button" className="outline-button compact-button" onClick={() => setSelected(tasks.filter((task) => task.available !== false && task.exportSupported).map(key))} disabled={busy || !tasks.length}>Select Exportable</button></div></div>
        <div className="task-list compare-task-list">{tasks.map((task) => { const enabled = task.available !== false && task.exportSupported; return <label className={`task-option ${enabled ? "" : "task-disabled"}`} key={key(task)}><input type="checkbox" checked={selected.includes(key(task))} disabled={!enabled || busy} onChange={() => setSelected((current) => current.includes(key(task)) ? current.filter((item) => item !== key(task)) : [...current, key(task)])} /><span><strong>{task.name}</strong></span></label>; })}{!tasks.length && <p className="empty-state">{taskSource === "search" ? "Search Oracle by task name to load exact task definitions." : "Select a setup and functional area to load configuration items."}</p>}</div>
        <div className="button-row compare-actions">
          <button onClick={validate} disabled={busy || !canValidate}>{busy ? "Validating..." : "Validate & Preview"}</button>
          {downloadUrl && <button className="outline-button" onClick={download}>Download Config Migration Report</button>}
        </div>
        {message && <p className={message.type === "success" ? "status-ok" : message.type === "info" ? "catalog-note" : "status-fail"}>{message.text}</p>}
        {busy && executionProgress && (
          <p className="catalog-note">
            <strong>{executionProgress.message || "Waiting for Oracle..."}</strong>
            {executionProgress.oracleProcessId ? ` · Process ${executionProgress.oracleProcessId}` : ""}
            {executionProgress.oracleStatus ? ` · Status ${executionProgress.oracleStatus}` : ""}
          </p>
        )}
      </section>

      {plan && (
        <>
          <section className="comparison-summary migration-summary">
            {[["Create", count(plan, "create")], ["Update", count(plan, "update")], ["Unchanged", count(plan, "noChange")], ["Skipped", count(plan, "skip")], ["Unsupported", count(plan, "unsupported")]].map(([label, value]) => <article className={`summary-${label.toLowerCase()}`} key={label}><span>{label}</span><strong>{value}</strong></article>)}
          </section>
          <section className="panel-card">
            <h2>Validation Results</h2>
            <div className={blockers.length ? "status-fail" : "status-ok"}>{blockers.length ? `${blockers.length} blocking issue(s). Execution disabled.` : noChanges ? "No changes detected. Source and destination already match." : "Ready to migrate after confirmation."}</div>
            {warnings.length > 0 && <p className="catalog-note">{warnings.length} warning(s). See the Excel report for full details.</p>}
            {blockers.slice(0, 8).map((error, index) => <p className="migration-error" key={`${error.code}-${index}`}><strong>{error.code}</strong>: {error.configurationName ? `${error.configurationName} — ` : ""}{error.message}</p>)}
          </section>
          <section className="panel-card">
            <h2>Config Migration Preview</h2>
            <div className="history-wrap"><table className="history-table comparison-table"><thead><tr><th>Operation</th><th>Configuration</th><th>Dataset</th><th>Record Key</th><th>Changes</th><th>Reason</th></tr></thead><tbody>{previewRows.map((row) => <tr key={row.id}><td><span className={`diff-status diff-${row.operation.toLowerCase().replace(/_/g, "-")}`}>{row.operation}</span></td><td>{row.configurationName}</td><td>{row.dataset}</td><td>{row.recordKey}</td><td>{row.changes?.length || 0}</td><td>{row.reason || "—"}</td></tr>)}</tbody></table></div>
          </section>
          {!noChanges && (
            <section className="panel-card">
              <h2>Execution Confirmation</h2>
              <p className="helper-text">Execution is server-side guarded, reuses the immutable plan, and is disabled when Oracle does not support CSV import for a selected task. To execute a ready plan, type: <strong>{exactConfirmation}</strong></p>
              <div className="input-action"><input value={confirmationText} onChange={(event) => setConfirmationText(event.target.value)} placeholder={exactConfirmation || "Select destination first"} /><button onClick={execute} disabled={busy || !canExecute}>{busy ? "Monitoring Oracle..." : "Execute Config Migration"}</button></div>
            </section>
          )}
        </>
      )}
    </>
  );
}

export default MigrationView;
