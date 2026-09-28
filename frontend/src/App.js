import React, { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import RunHistory from "./components/RunHistory";
import CompareView from "./components/CompareView";
import EnvironmentManager from "./components/EnvironmentManager";
import MigrationView from "./components/MigrationView";

const savedFusionBaseUrl = localStorage.getItem("fusionBaseUrl") || "";
const savedFusionUsername = localStorage.getItem("fusionUsername") || "";
const companyLogo = "/arcturus-logo.png";
const productName = "ArConfig";
const productTagline = "Oracle Fusion Configuration Management";

function formatTime(date = new Date()) {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function taskKey(task) {
  return task.code || task.name;
}

function createProgressId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function downloadGeneratedFile(filename) {
  const response = await axios.get(`/api/reports/${encodeURIComponent(filename)}`, { responseType: "blob" });
  const objectUrl = window.URL.createObjectURL(response.data);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(objectUrl);
}

function App() {
  const [runs, setRuns] = useState([]);
  const [orgCodes, setOrgCodes] = useState("");
  const [organizationScopeType, setOrganizationScopeType] = useState("business");
  const [showHistory, setShowHistory] = useState(false);
  const [activeView, setActiveView] = useState(() => localStorage.getItem("arconfigActiveView") || "dashboard");
  const [activityLog, setActivityLog] = useState([
    { time: formatTime(), type: "info", text: "Application started." },
  ]);
  const [fusionCredentials, setFusionCredentials] = useState({
    baseUrl: savedFusionBaseUrl,
    username: savedFusionUsername,
    password: "",
  });
  const [rememberCredentials, setRememberCredentials] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [offerings, setOfferings] = useState([]);
  const [offering, setOffering] = useState(null);
  const [functionalAreas, setFunctionalAreas] = useState([]);
  const [functionalArea, setFunctionalArea] = useState(null);
  const [taskMode, setTaskMode] = useState("all");
  const [taskSource, setTaskSource] = useState("area");
  const [taskSearch, setTaskSearch] = useState("");
  const [tasks, setTasks] = useState([]);
  const [selectedTaskKeys, setSelectedTaskKeys] = useState([]);
  const [catalogNote, setCatalogNote] = useState("");
  const [setupNote, setSetupNote] = useState("");
  const [extractionProgress, setExtractionProgress] = useState(null);
  const [snapshotCancelRequested, setSnapshotCancelRequested] = useState(false);
  const [snapshotRunKind, setSnapshotRunKind] = useState("");
  const activeProgressIdRef = useRef("");
  const snapshotCancelRequestedRef = useRef(false);

  const latestRun = runs[0];
  const selectedTasks = useMemo(
    () => tasks.filter((task) => selectedTaskKeys.includes(taskKey(task))),
    [selectedTaskKeys, tasks]
  );
  const visibleTasks = useMemo(
    () => taskSource === "area" && taskMode === "required"
      ? tasks.filter((task) => task.required === true)
      : tasks,
    [taskMode, taskSource, tasks]
  );
  const successfulTaskCount = latestRun?.taskResults?.filter((task) => task.status === "success").length || 0;

  const addLog = (text, type = "info") => {
    setActivityLog((current) => [
      { time: formatTime(), type, text },
      ...current,
    ].slice(0, 80));
  };

  const fetchHistory = async () => {
    try {
      const response = await axios.get("/api/extraction/history");
      setRuns(response.data);
    } catch (error) {
      console.error("Failed to load history", error);
    }
  };

  useEffect(() => {
    fetchHistory();
  }, []);

  useEffect(() => {
    localStorage.setItem("arconfigActiveView", activeView);
  }, [activeView]);

  const handleCredentialChange = (field, value) => {
    setFusionCredentials((current) => ({ ...current, [field]: value }));
  };

  const verifyFusionCredentials = async (clearPassword = false) => {
    const response = await axios.post("/api/auth/login", fusionCredentials);
    axios.defaults.headers.common.Authorization = `Bearer ${response.data.sessionToken}`;
    if (rememberCredentials) {
      localStorage.setItem("fusionBaseUrl", response.data.fusion.baseUrl);
      localStorage.setItem("fusionUsername", response.data.fusion.username);
    } else {
      localStorage.removeItem("fusionBaseUrl");
      localStorage.removeItem("fusionUsername");
    }
    setFusionCredentials((current) => ({
      ...current,
      baseUrl: response.data.fusion.baseUrl,
      username: response.data.fusion.username,
      password: clearPassword ? "" : current.password,
    }));
    return response;
  };

  const loadOfferings = async () => {
    setCatalogLoading(true);
    try {
      const response = await axios.post("/api/setup/offerings", {});
      setOfferings(response.data.offerings || []);
      addLog(`Loaded ${response.data.offerings?.length || 0} Oracle setups.`, "success");
    } catch (error) {
      const errorText = error.response?.data?.error || error.message;
      setMessage({ type: "error", text: `Could not load setups: ${errorText}` });
      addLog(`Setup loading failed: ${errorText}`, "error");
    } finally {
      setCatalogLoading(false);
    }
  };

  const loadFunctionalAreas = async (selectedOffering) => {
    if (!selectedOffering) return;
    setCatalogLoading(true);
    try {
      const response = await axios.post("/api/setup/functional-areas", {
        offering: selectedOffering,
      });
      setFunctionalAreas(response.data.functionalAreas || []);
      setSetupNote(response.data.note || "");
      addLog(`Loaded ${response.data.functionalAreas?.length || 0} functional areas.`, "success");
    } catch (error) {
      const errorText = error.response?.data?.error || error.message;
      setMessage({ type: "error", text: `Could not load functional areas: ${errorText}` });
      addLog(`Functional area loading failed: ${errorText}`, "error");
    } finally {
      setCatalogLoading(false);
    }
  };

  const selectTasksForMode = (mode, availableTasks) => {
    const selectable = availableTasks.filter(
      (task) => task.available !== false && task.exportSupported
    );
    const nextTasks = mode === "required"
      ? selectable.filter((task) => task.required === true)
      : selectable;
    setSelectedTaskKeys(nextTasks.map(taskKey));
  };

  const loadAreaTasks = async (area, mode = taskMode) => {
    setCatalogLoading(true);
    setTasks([]);
    setSelectedTaskKeys([]);
    setCatalogNote("");
    try {
      const response = await axios.post("/api/setup/area-tasks", {
        functionalAreaCode: area.code,
        functionalAreaName: area.name,
      });
      const areaTasks = response.data.tasks || [];
      setTasks(areaTasks);
      setCatalogNote(response.data.note || "");
      selectTasksForMode(mode, areaTasks);
      addLog(`Loaded ${areaTasks.length} task definitions for ${area.name}.`, "success");
    } catch (error) {
      const errorText = error.response?.data?.error || error.message;
      setMessage({ type: "error", text: `Could not load tasks: ${errorText}` });
      addLog(`Task loading failed: ${errorText}`, "error");
    } finally {
      setCatalogLoading(false);
    }
  };

  const handleTaskSourceChange = (source) => {
    setTaskSource(source);
    setTasks([]);
    setSelectedTaskKeys([]);
    setCatalogNote("");
    setExtractionProgress(null);
    setMessage(null);
    if (source === "area" && functionalArea) loadAreaTasks(functionalArea);
  };

  const handleSearchTasks = async (event) => {
    event.preventDefault();
    const search = taskSearch.trim();
    if (search.length < 2) {
      setMessage({ type: "error", text: "Enter at least two characters of a task name." });
      return;
    }

    setCatalogLoading(true);
    setCatalogNote("");
    setMessage(null);
    try {
      const response = await axios.post("/api/setup/task-search", {
        search,
      });
      const results = response.data.tasks || [];
      setTasks((currentTasks) => {
        const selectedKeys = new Set(selectedTaskKeys);
        const retainedSelections = currentTasks.filter((task) =>
          selectedKeys.has(taskKey(task))
        );
        const merged = new Map();
        for (const task of [...retainedSelections, ...results]) {
          merged.set(taskKey(task), task);
        }
        return Array.from(merged.values());
      });
      setCatalogNote(
        results.length
          ? `Found ${results.length} exact Oracle task definitions matching “${search}”. Previously selected tasks are retained.`
          : `Oracle returned no tasks matching “${search}”.`
      );
      addLog(`Oracle task search returned ${results.length} results for ${search}.`, "success");
    } catch (error) {
      const errorText = error.response?.data?.error || error.message;
      setMessage({ type: "error", text: `Could not search Oracle tasks: ${errorText}` });
      addLog(`Oracle task search failed: ${errorText}`, "error");
    } finally {
      setCatalogLoading(false);
    }
  };

  const handleLogin = async (event) => {
    event.preventDefault();
    setLoginLoading(true);
    setMessage(null);
    addLog("Testing Oracle Fusion connection...");
    try {
      await verifyFusionCredentials(true);
      setAuthenticated(true);
      setActiveView("dashboard");
      setMessage({ type: "success", text: "Fusion login successful." });
      addLog("Login connection test succeeded.", "success");
      await loadOfferings();
      await fetchHistory();
    } catch (error) {
      const errorText = error.response?.data?.error || error.message;
      setAuthenticated(false);
      setMessage({ type: "error", text: errorText });
      addLog(`Login failed: ${errorText}`, "error");
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    setAuthenticated(false);
    delete axios.defaults.headers.common.Authorization;
    setActiveView("dashboard");
    setFusionCredentials((current) => ({ ...current, password: "" }));
    setOfferings([]);
    setOffering(null);
    setFunctionalAreas([]);
    setFunctionalArea(null);
    setTaskSource("area");
    setTaskSearch("");
    setTasks([]);
    setSelectedTaskKeys([]);
    setSetupNote("");
    setCatalogNote("");
    setExtractionProgress(null);
    setMessage(null);
    addLog("Logged out.");
  };

  const handleTestConnection = async () => {
    setLoading(true);
    setMessage(null);
    addLog("Testing Oracle Fusion connection...");
    try {
      if (authenticated && !fusionCredentials.password) await axios.post("/api/auth/test");
      else await verifyFusionCredentials(false);
      setMessage({ type: "success", text: "Connection test succeeded." });
      addLog("Connection test succeeded.", "success");
    } catch (error) {
      const errorText = error.response?.data?.error || error.message;
      setMessage({ type: "error", text: errorText });
      addLog(`Connection test failed: ${errorText}`, "error");
    } finally {
      setLoading(false);
    }
  };

  const handleOfferingChange = async (event) => {
    const code = event.target.value;
    const selectedOffering = code === "ALL"
      ? { code: "ALL", name: "All Setups" }
      : offerings.find((item) => item.code === code) || null;

    setOffering(selectedOffering);
    setFunctionalAreas([]);
    setFunctionalArea(null);
    setTasks([]);
    setSelectedTaskKeys([]);
    setSetupNote("");
    setCatalogNote("");
    setExtractionProgress(null);
    setMessage(null);
    if (selectedOffering) await loadFunctionalAreas(selectedOffering);
  };

  const handleFunctionalAreaChange = async (event) => {
    const area = functionalAreas.find((item) => item.code === event.target.value) || null;
    setFunctionalArea(area);
    setTaskSource("area");
    setExtractionProgress(null);
    setMessage(null);
    if (area) await loadAreaTasks(area);
  };

  const handleTaskModeChange = (event) => {
    const mode = event.target.value;
    setTaskMode(mode);
    selectTasksForMode(mode, tasks);
  };

  const toggleTask = (task) => {
    const key = taskKey(task);
    setSelectedTaskKeys((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
    );
  };

  const handleToggleHistory = async () => {
    const nextValue = !showHistory;
    setShowHistory(nextValue);
    if (nextValue) await fetchHistory();
  };

  const handleRun = async () => {
    if (taskSource === "area" && !functionalArea) {
      setMessage({ type: "error", text: "Select a functional area first." });
      return;
    }
    if (!selectedTasks.length) {
      setMessage({ type: "error", text: "Select at least one setup task." });
      return;
    }

    setLoading(true);
    setSnapshotRunKind("area");
    setSnapshotCancelRequested(false);
    snapshotCancelRequestedRef.current = false;
    setMessage(null);
    const progressId = createProgressId();
    activeProgressIdRef.current = progressId;
    setExtractionProgress({
      id: progressId,
      phase: "starting",
      totalTasks: selectedTasks.length,
      completedCount: 0,
      successCount: 0,
      failedCount: 0,
      percent: 0,
      currentTask: null,
      completedTasks: [],
      message: "Submitting extraction to Oracle...",
    });
    const extractionArea = taskSource === "search"
      ? { code: "GLOBAL_TASK_SEARCH", name: "All Oracle Setup Tasks" }
      : functionalArea;
    addLog(`Extracting ${selectedTasks.length} tasks from ${extractionArea.name}...`);
    const pollProgress = async () => {
      try {
        const progressResponse = await axios.get(`/api/extraction/progress/${progressId}`);
        setExtractionProgress(progressResponse.data);
      } catch (error) {
        if (error.response?.status !== 404) console.error("Failed to load extraction progress", error);
      }
    };
    const progressTimer = window.setInterval(pollProgress, 1500);
    try {
      const response = await axios.post("/api/extraction/run", {
        progressId,
        orgCodes,
        offering: taskSource === "search" ? { code: "ALL", name: "All Setups" } : offering,
        functionalArea: extractionArea,
        taskMode: taskSource === "search" ? "selected" : taskMode,
        tasks: selectedTasks,
      });
      const run = response.data.run;
      const successText = `${run.taskCount} tasks processed, ${run.recordCount} records written (${run.status}).`;
      if (!snapshotCancelRequestedRef.current) {
        setMessage({ type: run.status === "success" ? "success" : "error", text: successText });
        addLog(successText, run.status === "success" ? "success" : "error");
        addLog(`Combined workbook ready: ${run.outputFile}`, "success");
      }
      await pollProgress();
      await fetchHistory();
    } catch (error) {
      const errorText = error.response?.data?.error || error.message;
      const cancelled = snapshotCancelRequestedRef.current || error.response?.data?.code === "EXTRACTION_CANCELLED";
      setMessage({ type: cancelled ? "success" : "error", text: cancelled ? "Snapshot cancelled." : errorText });
      await pollProgress();
      setExtractionProgress((current) => current?.phase === "failed" ? current : {
        ...current,
        phase: cancelled ? "cancelled" : "failed",
        message: cancelled ? "Snapshot cancelled." : errorText,
      });
      addLog(cancelled ? "Snapshot cancelled by user." : `Snapshot failed: ${errorText}`, cancelled ? "success" : "error");
    } finally {
      window.clearInterval(progressTimer);
      setLoading(false);
      setSnapshotRunKind("");
      setSnapshotCancelRequested(false);
      snapshotCancelRequestedRef.current = false;
      activeProgressIdRef.current = "";
    }
  };

  const handleCompleteSetupRun = async () => {
    if (!offering) {
      setMessage({ type: "error", text: "Select one setup or All Setups first." });
      return;
    }

    setLoading(true);
    setSnapshotRunKind("complete");
    setSnapshotCancelRequested(false);
    snapshotCancelRequestedRef.current = false;
    setMessage(null);
    const progressId = createProgressId();
    activeProgressIdRef.current = progressId;
    setExtractionProgress({
      id: progressId,
      phase: "discovering",
      totalTasks: 0,
      completedCount: 0,
      successCount: 0,
      failedCount: 0,
      percent: 0,
      currentTask: null,
      completedTasks: [],
      message: `Loading all functional areas for ${offering.name}...`,
    });
    addLog(`Starting complete setup ZIP for ${offering.name}...`);

    const pollProgress = async () => {
      try {
        const response = await axios.get(`/api/extraction/progress/${progressId}`);
        setExtractionProgress(response.data);
      } catch (error) {
        if (error.response?.status !== 404) console.error("Failed to load extraction progress", error);
      }
    };
    const progressTimer = window.setInterval(pollProgress, 1500);

    try {
      const response = await axios.post("/api/extraction/complete-setup", {
        progressId,
        orgCodes,
        offering,
      });
      const run = response.data.run;
      if (!snapshotCancelRequestedRef.current) {
        const successText = `${run.taskCount} tasks and ${run.recordCount} records packaged into ${run.outputFile}.`;
        setMessage({ type: run.status === "success" ? "success" : "error", text: successText });
        addLog(successText, run.status === "success" ? "success" : "error");
        await downloadGeneratedFile(run.outputFile);
      }
      await pollProgress();
      await fetchHistory();
    } catch (error) {
      const errorText = error.response?.data?.error || error.message;
      const cancelled = snapshotCancelRequestedRef.current || error.response?.data?.code === "EXTRACTION_CANCELLED";
      setMessage({ type: cancelled ? "success" : "error", text: cancelled ? "Complete setup export cancelled." : errorText });
      await pollProgress();
      setExtractionProgress((current) => ({
        ...current,
        phase: cancelled ? "cancelled" : "failed",
        message: cancelled ? "Complete setup export cancelled." : errorText,
      }));
      addLog(cancelled ? "Complete setup export cancelled by user." : `Complete setup export failed: ${errorText}`, cancelled ? "success" : "error");
    } finally {
      window.clearInterval(progressTimer);
      setLoading(false);
      setSnapshotRunKind("");
      setSnapshotCancelRequested(false);
      snapshotCancelRequestedRef.current = false;
      activeProgressIdRef.current = "";
    }
  };

  const handleCancelSnapshot = async () => {
    const progressId = activeProgressIdRef.current || extractionProgress?.id;
    if (!progressId || snapshotCancelRequested) return;
    setSnapshotCancelRequested(true);
    snapshotCancelRequestedRef.current = true;
    setMessage({ type: "success", text: "Cancelling snapshot. The current Oracle request may finish, then the run will stop." });
    setExtractionProgress((current) => current ? {
      ...current,
      phase: "cancelling",
      cancellationRequested: true,
      message: "Cancelling snapshot. Stopping after the current task...",
    } : current);
    try {
      await axios.post(`/api/extraction/cancel/${progressId}`);
      addLog("Snapshot cancellation requested.", "success");
    } catch (error) {
      const errorText = error.response?.data?.error || error.message;
      setMessage({ type: "error", text: `Could not cancel snapshot: ${errorText}` });
      setSnapshotCancelRequested(false);
      snapshotCancelRequestedRef.current = false;
      addLog(`Snapshot cancellation failed: ${errorText}`, "error");
    }
  };

  const renderMessage = () => message && (
    <p className={message.type === "success" ? "status-ok" : "status-fail"}>{message.text}</p>
  );

  const renderAuthPage = () => (
    <main className="auth-page">
      <div className="window-title">Arcturus {productName} · {productTagline}</div>
      <section className="login-card">
        <div className="login-brand">
          <img src={companyLogo} alt="Arcturus Consulting Services Inc" className="company-logo login-company-logo" />
          <h1>{productName}</h1>
          <p>{productTagline}</p>
        </div>
        <form className="login-panel" onSubmit={handleLogin}>
          <label htmlFor="fusion-base-url">Oracle Fusion URL</label>
          <input id="fusion-base-url" value={fusionCredentials.baseUrl} onChange={(event) => handleCredentialChange("baseUrl", event.target.value)} placeholder="https://your-instance.oraclecloud.com" disabled={loginLoading} required />
          <label htmlFor="fusion-username">Username</label>
          <input id="fusion-username" value={fusionCredentials.username} onChange={(event) => handleCredentialChange("username", event.target.value)} placeholder="Fusion username" disabled={loginLoading} required />
          <label htmlFor="fusion-password">Password</label>
          <input id="fusion-password" type="password" value={fusionCredentials.password} onChange={(event) => handleCredentialChange("password", event.target.value)} placeholder="Password" disabled={loginLoading} required />
          <label className="checkbox-row"><input type="checkbox" checked={rememberCredentials} onChange={(event) => setRememberCredentials(event.target.checked)} disabled={loginLoading} />Remember URL and username</label>
          {renderMessage()}
          <div className="login-actions">
            <button className="outline-button" type="button" onClick={() => setShowLogin(false)} disabled={loginLoading}>Back</button>
            <button className="outline-button" type="button" onClick={handleTestConnection} disabled={loginLoading || loading}>Test Connection</button>
            <button type="submit" disabled={loginLoading}>{loginLoading ? "Checking..." : "Login"}</button>
          </div>
        </form>
      </section>
    </main>
  );

  const renderLandingPage = () => (
    <main className="landing-page">
      <section className="landing-hero">
        <div className="landing-glow landing-glow-left" />
        <div className="landing-glow landing-glow-right" />
        <div className="landing-shelf" />
        <img src={companyLogo} alt="Arcturus Consulting Services Inc" className="company-logo landing-company-logo" />
        <div className="landing-content">
          <p className="company-eyebrow">Arcturus Consulting Services Inc.</p>
          <h1><span>Smarter</span> Systems.<br /><strong>Stronger</strong> Outcomes.</h1>
          <div className="landing-service-grid">
            <span>Oracle Cloud Consulting</span>
            <span>Application Managed Services</span>
            <span>Demo as a Service</span>
            <span>Staff Augmentation Solutions</span>
          </div>
          <div className="product-intro-card">
            <p>Introducing</p>
            <h2>{productName}</h2>
            <span>{productTagline}</span>
          </div>
          <div className="landing-actions">
            <button onClick={() => setShowLogin(true)}>Continue to Login</button>
          </div>
        </div>
      </section>
    </main>
  );

  const renderDashboard = () => (
    <>
      <div className="page-heading"><h1>Welcome back, {fusionCredentials.username || "User"}</h1><p>{productName} helps manage Oracle Fusion configuration snapshots, comparisons, and migration planning.</p></div>
      <section className="metrics-grid">
        <article className="metric-card"><span className="metric-label">Oracle Connection</span><strong className="metric-success">Connected</strong><p>{fusionCredentials.baseUrl}</p></article>
        <article className="metric-card"><span className="metric-label">Setup and Functional Area</span><strong>{functionalArea?.name || offering?.name || "Not selected"}</strong><p>{offering?.name ? `${offering.name} · ` : ""}{selectedTasks.length} setup tasks selected.</p></article>
        <article className="metric-card"><span className="metric-label">Last Snapshot</span><strong>{latestRun ? new Date(latestRun.createdAt).toLocaleString() : "No snapshot yet"}</strong><p>{latestRun ? `${successfulTaskCount || latestRun.taskCount || 0} tasks, ${latestRun.recordCount || 0} records.` : "Generate a snapshot to create a workbook."}</p></article>
      </section>
      <section className="panel-card"><h2>Quick Actions</h2><div className="button-row"><button className="outline-button" onClick={handleTestConnection} disabled={loading}>Test Connection</button><button onClick={() => setActiveView("snapshot")}>Config Snapshot</button><button onClick={() => setActiveView("compare")}>Config Compare</button><button onClick={() => setActiveView("migration")}>Config Migration</button></div>{renderMessage()}</section>
      {showHistory && <section className="panel-card"><h2>Recent Run History</h2><div className="history-wrap"><RunHistory runs={runs} /></div></section>}
    </>
  );

  const renderTaskList = () => (
    <div className="task-list">
      {visibleTasks.length === 0 && <p className="empty-state">{tasks.length === 0 ? (taskSource === "search" ? "Search Oracle by task name to see exact task definitions." : "Select a functional area to load its Oracle setup tasks automatically.") : "No tasks are marked as required for this functional area."}</p>}
      {visibleTasks.map((task) => {
        const selectable = task.available !== false && task.exportSupported;
        return (
          <label className={`task-option ${selectable ? "" : "task-disabled"}`} key={taskKey(task)}>
            <input type="checkbox" checked={selectedTaskKeys.includes(taskKey(task))} onChange={() => toggleTask(task)} disabled={!selectable || loading} />
            <span><strong>{task.name}</strong></span>
            <span className="task-badges">
              {task.required && <em>Required</em>}
              {task.available === false && <em className="warning-chip">Not available to user</em>}
              {!task.exportSupported && <em className="warning-chip">No export available</em>}
            </span>
          </label>
        );
      })}
    </div>
  );

  const renderProgressStatus = () => {
    if (!extractionProgress) {
      return (
        <div className="status-grid">
          <span>Selected Tasks: {selectedTasks.length}</span>
          <span>Last Records: {latestRun?.recordCount || 0}</span>
          <span>Last Run: {latestRun ? new Date(latestRun.createdAt).toLocaleString() : "Not available"}</span>
        </div>
      );
    }

    const currentTask = extractionProgress.currentTask;
    const recentTasks = extractionProgress.completedTasks || [];
    const displayPhase =
      extractionProgress.phase === "completed" && extractionProgress.runStatus !== "success"
        ? extractionProgress.runStatus
        : extractionProgress.phase;
    const phaseLabel = displayPhase === "partial" ? "Completed with errors" : displayPhase;
    return (
      <div className="live-progress">
        <div className="live-progress-heading">
          <div>
            <strong>{extractionProgress.message}</strong>
            {currentTask && <p>Task {currentTask.index} of {extractionProgress.totalTasks}: {currentTask.name}</p>}
          </div>
          <span className={`phase-badge phase-${displayPhase}`}>{phaseLabel}</span>
        </div>
        <div className="status-grid">
          <span>Completed: {extractionProgress.completedCount}/{extractionProgress.totalTasks}</span>
          <span>Successful: {extractionProgress.successCount}</span>
          <span>Failed: {extractionProgress.failedCount}</span>
        </div>
        {recentTasks.length > 0 && (
          <div className="recent-progress-tasks">
            {recentTasks.slice(-5).reverse().map((task) => (
              <div className={`progress-task progress-task-${task.status}`} key={`${task.index}-${task.code || task.name}`}>
                <span>{task.status === "success" ? "✓" : "×"}</span>
                <p><strong>{task.index}. {task.name}</strong><small>{task.status === "success" ? `${task.recordCount} records` : task.errorMessage}</small></p>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderSnapshot = () => (
    <>
      <div className="page-heading"><h1>Config Snapshot</h1><p>Export selected tasks to one workbook, or package a complete setup with every functional area into a ZIP.</p></div>
      <section className="panel-card">
        <div className="configuration-heading"><h2>Config Snapshot Setup</h2><div className="source-switch"><button type="button" className={taskSource === "area" ? "" : "outline-button"} onClick={() => handleTaskSourceChange("area")} disabled={loading || catalogLoading}>Browse Functional Areas</button><button type="button" className={taskSource === "search" ? "" : "outline-button"} onClick={() => handleTaskSourceChange("search")} disabled={loading || catalogLoading}>Search All Tasks</button></div></div>
        {taskSource === "area" ? (
          <div className="selection-grid">
            <label>Setup<select value={offering?.code || ""} onChange={handleOfferingChange} disabled={loading || catalogLoading}><option value="">Select a setup</option><option value="ALL">All Setups</option>{offerings.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
            <label>Functional Area<select value={functionalArea?.code || ""} onChange={handleFunctionalAreaChange} disabled={loading || catalogLoading || !offering}><option value="">Select a functional area</option>{functionalAreas.map((area) => <option key={area.code} value={area.code}>{area.name}</option>)}</select></label>
            <label>Show Tasks<select value={taskMode} onChange={handleTaskModeChange} disabled={loading || catalogLoading}><option value="required">Required Tasks</option><option value="all">All Tasks</option></select></label>
          </div>
        ) : (
          <form className="task-search-form" onSubmit={handleSearchTasks}>
            <label htmlFor="task-search">Oracle task name<input id="task-search" value={taskSearch} onChange={(event) => setTaskSearch(event.target.value)} placeholder="For example: Manage Requisition Approvals" disabled={loading || catalogLoading} autoFocus /></label>
            <button type="submit" disabled={loading || catalogLoading || taskSearch.trim().length < 2}>{catalogLoading ? "Searching..." : "Search Oracle"}</button>
          </form>
        )}
        {catalogLoading && <p className="helper-text">Loading Oracle setup metadata...</p>}
        {taskSource === "area" && setupNote && <p className="catalog-note">{setupNote}</p>}
        {catalogNote && <p className="catalog-note">{catalogNote}</p>}
        {taskSource === "area" && offering && <p className="catalog-note"><strong>Complete setup export:</strong> Generate a ZIP containing one folder per setup and one Excel workbook per functional area. Each workbook contains its setup tasks and configuration data. Selecting All Setups creates all setup folders in one ZIP.</p>}
        <div className="task-heading"><div><h2>Tasks</h2><p>{selectedTasks.length} of {visibleTasks.length} selected</p></div><div className="task-heading-actions"><button className="outline-button compact-button" onClick={() => setSelectedTaskKeys([])} disabled={loading || !tasks.length || !selectedTaskKeys.length}>Clear Selection</button><button className="outline-button compact-button" onClick={() => selectTasksForMode(taskSource === "search" ? "all" : taskMode, tasks)} disabled={loading || !tasks.length}>Reset Selection</button></div></div>
        {renderTaskList()}
        <div className="field-group scope-field"><label>Organization scope (used by organization-scoped extractors)</label><div className="scope-selection-grid"><select value={organizationScopeType} onChange={(event) => setOrganizationScopeType(event.target.value)} disabled={loading}><option value="business">Business Organization</option><option value="inventory">Inventory Organization</option></select><input id="org-codes" value={orgCodes} onChange={(event) => setOrgCodes(event.target.value)} placeholder={organizationScopeType === "inventory" ? "ALL, Vision Operations, M1" : "ALL, Business Unit name or code"} disabled={loading} /></div><p className="helper-text">{organizationScopeType === "inventory" ? "Use Inventory Organization for Configure Subinventories and Facilities → Manage Inventory Organizations." : "Use Business Organization for business-unit scoped setup exports. Other FSM task exports use the scope available to your Fusion account."}</p></div>
        <div className="button-row"><button className="outline-button" onClick={handleTestConnection} disabled={loading}>Test Connection</button><button onClick={handleRun} disabled={loading || catalogLoading || !selectedTasks.length}>{loading && snapshotRunKind === "area" ? "Extracting Tasks..." : "Generate Selected Workbook"}</button>{taskSource === "area" && <button onClick={handleCompleteSetupRun} disabled={loading || catalogLoading || !offering}>{loading && snapshotRunKind === "complete" ? "Building Complete ZIP..." : offering?.code === "ALL" ? "Generate All Setups ZIP" : "Generate Complete Setup ZIP"}</button>}{loading && <button className="danger-button" type="button" onClick={handleCancelSnapshot} disabled={snapshotCancelRequested}>{snapshotCancelRequested ? "Cancelling..." : "Cancel Task"}</button>}<button className="outline-button" onClick={handleToggleHistory} disabled={loading}>{showHistory ? "Hide History" : "Run History"}</button></div>
        {renderMessage()}
      </section>
      <section className="panel-card"><h2>Status</h2><div className="progress-track"><span style={{ width: `${extractionProgress?.percent ?? (latestRun ? 100 : 0)}%` }} /></div>{renderProgressStatus()}</section>
      {showHistory && <section className="panel-card"><h2>Run History</h2><div className="history-wrap"><RunHistory runs={runs} /></div></section>}
    </>
  );

  const renderLogs = () => (<><div className="page-heading"><h1>Application Logs</h1><p>View metadata loading, extraction, and workbook events.</p></div><section className="panel-card"><div className="log-console">{activityLog.map((entry, index) => <p className={`log-line log-${entry.type}`} key={`${entry.time}-${index}`}><span>[{entry.time}]</span> {entry.text}</p>)}</div><div className="button-row"><button className="outline-button" onClick={() => setActivityLog([])}>Clear Logs</button><button onClick={() => { setShowHistory(true); setActiveView("dashboard"); }}>Open Run History</button></div></section></>);

  const renderSettings = () => (<><div className="page-heading"><h1>Settings</h1><p>Manage the current session and reusable Oracle environments.</p></div><section className="panel-card"><h2>Current Connection</h2><div className="field-grid"><label>Oracle Fusion URL<input value={fusionCredentials.baseUrl} onChange={(event) => handleCredentialChange("baseUrl", event.target.value)} /></label><label>Username<input value={fusionCredentials.username} onChange={(event) => handleCredentialChange("username", event.target.value)} /></label><label>Password<input type="password" value={fusionCredentials.password} onChange={(event) => handleCredentialChange("password", event.target.value)} placeholder="Enter only to replace the current session" /></label></div><div className="button-row"><button className="outline-button" onClick={handleTestConnection} disabled={loading}>Test Connection</button><button onClick={loadOfferings} disabled={loading || catalogLoading}>Refresh Setup Metadata</button></div>{renderMessage()}</section><section className="panel-card"><h2>Saved Environments</h2><p className="helper-text">Credentials are encrypted by the backend and passwords are never returned to the browser. Development creates a private local key automatically; production requires CREDENTIAL_ENCRYPTION_KEY.</p><EnvironmentManager /></section></>);

  if (!authenticated) return showLogin ? renderAuthPage() : renderLandingPage();
  const content = activeView === "snapshot"
    ? renderSnapshot()
    : activeView === "compare"
      ? <CompareView offerings={offerings} addLog={addLog} refreshHistory={fetchHistory} onOpenSettings={() => setActiveView("settings")} />
      : activeView === "migration"
        ? <MigrationView offerings={offerings} addLog={addLog} refreshHistory={fetchHistory} onOpenSettings={() => setActiveView("settings")} />
        : activeView === "logs"
          ? renderLogs()
          : activeView === "settings"
            ? renderSettings()
            : renderDashboard();

  return (
    <main className="desktop-shell">
      <aside className="sidebar"><div><div className="sidebar-brand"><img src={companyLogo} alt="Arcturus Consulting Services Inc" className="company-logo sidebar-company-logo" /><strong>{productName}</strong><span>{productTagline}</span></div><nav className="side-nav"><button className={activeView === "dashboard" ? "active" : ""} onClick={() => setActiveView("dashboard")}>Dashboard</button><button className={activeView === "snapshot" ? "active" : ""} onClick={() => setActiveView("snapshot")}>Config Snapshot</button><button className={activeView === "compare" ? "active" : ""} onClick={() => setActiveView("compare")}>Config Compare</button><button className={activeView === "migration" ? "active" : ""} onClick={() => setActiveView("migration")}>Config Migration</button><button className={activeView === "logs" ? "active" : ""} onClick={() => setActiveView("logs")}>Logs</button><button className={activeView === "settings" ? "active" : ""} onClick={() => setActiveView("settings")}>Settings</button></nav></div><div className="sidebar-footer"><p><span>Connection:</span><strong className="connected-dot">Connected</strong></p><p><span>User:</span><strong>{fusionCredentials.username}</strong></p><button className="sidebar-logout" onClick={handleLogout} disabled={loading}>Logout</button></div></aside>
      <section className="content-area">{content}</section>
    </main>
  );
}

export default App;
