(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };
  const state = {
    config: null,
    sample: null,
    selectedSampleId: "",
    snapshot: null,
    pollTimer: null,
    pollInFlight: false,
    actionInFlight: false,
    sampleLoadToken: 0,
    renderedSignature: "",
    downloadedRunId: ""
  };

  const labels = {
    title: "活动名称",
    date: "日期",
    time: "时间",
    location: "地点",
    capacity: "人数上限",
    registered: "已报名",
    waitlist: "候补人数",
    weatherBackup: "天气预案",
    weather_backup: "天气预案",
    status: "状态",
    summary: "摘要"
  };

  const statusLabels = {
    IDLE: "尚未运行",
    CREATED: "已创建",
    RUNNING: "运行中",
    FINISHED: "已完成",
    STOPPED: "已停止",
    FAILED: "失败",
    NOT_CHECKED: "尚未检查",
    CONDITIONAL: "有条件",
    READY_FOR_REVIEW: "待人工复核",
    PASS: "通过",
    FAIL: "未通过",
    UNKNOWN: "未知",
    PENDING: "等待中",
    QUEUED: "排队中",
    ACTIVE: "执行中",
    DONE: "已完成",
    COMPLETE: "已完成",
    SKIPPED: "已跳过"
  };

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function hasOwn(value, key) {
    return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
  }

  function asArray(value) {
    if (value === null || value === undefined) return [];
    return Array.isArray(value) ? value : [value];
  }

  function safeJson(value, pretty = false) {
    try {
      return JSON.stringify(value, null, pretty ? 2 : 0);
    } catch {
      return "[无法显示此值]";
    }
  }

  function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (isRecord(value)) {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    }
    return safeJson(value);
  }

  function toText(value, empty = "—") {
    if (value === null || value === undefined || value === "") return empty;
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return safeJson(value, true) || empty;
  }

  function firstValue(record, keys) {
    for (const key of keys) {
      if (hasOwn(record, key) && record[key] !== null && record[key] !== undefined && record[key] !== "") {
        return record[key];
      }
    }
    return undefined;
  }

  function setText(id, value, empty = "—") {
    const node = $(id);
    if (node) node.textContent = toText(value, empty);
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function displayStatus(value) {
    if (value === null || value === undefined || value === "") return "—";
    if (typeof value !== "string") return toText(value);
    return statusLabels[value] || value;
  }

  function setActionStatus(message, kind = "") {
    const node = $("actionStatus");
    node.textContent = message;
    if (kind) node.dataset.kind = kind;
    else delete node.dataset.kind;
  }

  function apiErrorMessage(error) {
    if (error && Number.isInteger(error.httpStatus)) {
      return `本地服务返回 HTTP ${error.httpStatus}；请查看服务状态后重试。`;
    }
    if (error && error.name === "TypeError") return "无法连接本地服务；请确认工作台服务正在运行。";
    return "本地服务未返回可用数据；请稍后重试。";
  }

  async function requestJson(path, options = {}) {
    const response = await fetch(path, {
      cache: "no-store",
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      }
    });
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("invalid-json");
    }
    if (!response.ok) {
      const error = new Error("http-error");
      error.httpStatus = response.status;
      throw error;
    }
    return data;
  }

  function setBusy(isBusy) {
    state.actionInFlight = isBusy;
    updateButtons();
  }

  function updateButtons() {
    const status = state.snapshot?.status;
    const active = status === "RUNNING" || status === "CREATED";
    const terminal = status === "FINISHED" || status === "STOPPED" || status === "FAILED";
    const modeIsMock = !state.config || (state.config.mode === "MOCK" && state.config.liveEnabled !== true);
    $("sampleSelect").disabled = !state.config || !state.selectedSampleId || active || state.actionInFlight;
    $("startButton").disabled = !state.config || !state.selectedSampleId || !modeIsMock || active || state.actionInFlight;
    $("stopButton").disabled = !state.snapshot || !active || state.actionInFlight;
    $("freezeButton").disabled = !state.snapshot || !terminal || state.snapshot.artifactStatus !== "CANDIDATE" || state.actionInFlight;
  }

  function sourceText(source) {
    if (typeof source === "string") return source;
    return toText(firstValue(source, ["text", "content", "excerpt", "body"]), isRecord(source) ? safeJson(source, true) : "");
  }

  function sourceTitle(source, index) {
    if (typeof source === "string") return `来源 ${index + 1}`;
    return toText(firstValue(source, ["title", "name", "label", "id"]), `来源 ${index + 1}`);
  }

  function sourceId(source, index) {
    if (isRecord(source) && source.id !== undefined && source.id !== null) return String(source.id);
    return `source-${index + 1}`;
  }

  function renderSampleSources(sources) {
    const list = $("sampleSourceList");
    clear(list);
    const rows = asArray(sources);
    $("sourceCount").textContent = `${rows.length} 项`;
    if (rows.length === 0) {
      list.append(el("p", "empty-note", "该样本没有提供来源文本。"));
      return;
    }
    rows.forEach((source, index) => {
      const card = el("article", "source-preview-item");
      card.append(el("strong", "source-preview-title", sourceTitle(source, index)));
      card.append(el("p", "source-preview-text", sourceText(source)));
      list.append(card);
    });
  }

  function renderSampleSummary(sample) {
    if (!sample) {
      setText("sampleTitle", "请选择本地样本");
      setText("sampleMeta", "—");
      renderSampleSources([]);
      return;
    }
    const title = firstValue(sample, ["title"]) || firstValue(sample.original, ["title"]) || sample.id;
    const syntheticLabel = sample.synthetic === true ? "合成样本" : "未标记为合成";
    const sourceTotal = asArray(sample.sources).length;
    setText("sampleTitle", title || "未命名样本");
    setText("sampleMeta", `ID ${toText(sample.id)} · ${syntheticLabel} · ${sourceTotal} 条来源`);
    renderSampleSources(sample.sources);
  }

  function flattenFields(value, prefix = "", output = new Map()) {
    if (isRecord(value)) {
      const keys = Object.keys(value);
      if (keys.length === 0) output.set(prefix || "方案", value);
      for (const key of keys) {
        const path = prefix ? `${prefix} / ${key}` : key;
        const item = value[key];
        if (isRecord(item) && Object.keys(item).length > 0) flattenFields(item, path, output);
        else output.set(path, item);
      }
      return output;
    }
    output.set(prefix || "方案", value);
    return output;
  }

  function displayFieldValue(value, exists) {
    if (!exists) return "—";
    return toText(value, "空");
  }

  function renderPlanComparison(original, proposal, hasProposal) {
    const body = $("planRows");
    clear(body);
    const before = flattenFields(original ?? {});
    const after = hasProposal ? flattenFields(proposal) : new Map();
    const paths = [...before.keys(), ...[...after.keys()].filter((path) => !before.has(path))];
    if (paths.length === 0) {
      const row = el("tr");
      row.append(el("td", "table-empty", "没有可比较的计划字段。"));
      const blank = el("td", "table-empty", "—");
      blank.colSpan = 2;
      row.append(blank);
      body.append(row);
      return;
    }
    for (const path of paths) {
      const hasBefore = before.has(path);
      const hasAfter = after.has(path);
      const oldValue = before.get(path);
      const newValue = after.get(path);
      const changed = hasProposal && (hasBefore !== hasAfter || stableJson(oldValue) !== stableJson(newValue));
      const row = el("tr", changed ? "is-changed" : "");
      if (changed && !hasBefore) row.classList.add("is-added");
      if (changed && !hasAfter) row.classList.add("is-removed");
      row.append(el("td", "", path.split(" / ").map((part) => labels[part] || part).join(" / ")));
      const oldCell = el("td", changed ? "changed-cell" : "", displayFieldValue(oldValue, hasBefore));
      const newCell = el("td", changed ? "changed-cell" : "", hasProposal ? displayFieldValue(newValue, hasAfter) : "等待运行");
      row.append(oldCell, newCell);
      body.append(row);
    }
  }

  function renderAttachment(original, attachment) {
    const body = $("attachmentRows");
    clear(body);
    const before = isRecord(original) ? original : {};
    const reference = isRecord(attachment) ? attachment : {};
    const knownKeys = ["time", "capacity", "registered", "waitlist"];
    const keys = [...knownKeys.filter((key) => hasOwn(before, key) || hasOwn(reference, key))];
    for (const key of Object.keys(reference)) if (!keys.includes(key)) keys.push(key);
    if (keys.length === 0 && attachment !== undefined && attachment !== null && !isRecord(attachment)) {
      const row = el("tr");
      row.append(el("td", "", "附件记录"), el("td", "", "—"), el("td", "", toText(attachment)));
      const tagCell = el("td", "");
      tagCell.append(el("span", "difference-tag", "待核对"));
      row.append(tagCell);
      body.append(row);
      return;
    }
    if (keys.length === 0) {
      const row = el("tr");
      const cell = el("td", "table-empty", "样本未提供可比较的附件字段。");
      cell.colSpan = 4;
      row.append(cell);
      body.append(row);
      return;
    }
    for (const key of keys) {
      const inOriginal = hasOwn(before, key);
      const inAttachment = hasOwn(reference, key);
      const differs = inOriginal !== inAttachment || (inOriginal && inAttachment && stableJson(before[key]) !== stableJson(reference[key]));
      const row = el("tr");
      row.append(el("td", "", labels[key] || key));
      row.append(el("td", "", displayFieldValue(before[key], inOriginal)));
      row.append(el("td", differs ? "is-different" : "", displayFieldValue(reference[key], inAttachment)));
      const tagCell = el("td", differs ? "is-different" : "");
      tagCell.append(el("span", `difference-tag${differs ? " is-different" : ""}`, differs ? "有差异" : "一致"));
      row.append(tagCell);
      body.append(row);
    }
  }

  function renderAgents(agents) {
    const container = $("agentCards");
    clear(container);
    const items = asArray(agents).filter((item) => item !== null && item !== undefined);
    const fallbackRoles = { A: "事实核对", B: "计划审阅", C: "方案负责人" };
    const byId = new Map();
    for (const item of items) {
      if (isRecord(item) && item.id !== undefined) byId.set(String(item.id), item);
    }
    const identifiers = ["A", "B", "C"];
    for (const id of identifiers) {
      const agent = byId.get(id);
      const card = el("article", "agent-card");
      const top = el("div", "agent-card-top");
      top.append(el("span", "agent-id", id));
      top.append(el("span", "agent-status", agent ? displayStatus(agent.status) : "待开始"));
      card.append(top);
      const name = agent ? firstValue(agent, ["name", "role", "title"]) : fallbackRoles[id];
      card.append(el("strong", "agent-name", name || fallbackRoles[id]));
      if (agent && agent.status !== undefined && agent.name !== undefined && agent.role !== undefined && agent.role !== agent.name) {
        card.append(el("p", "agent-extra", toText(agent.role)));
      }
      container.append(card);
    }
    for (const item of items) {
      if (!isRecord(item) || identifiers.includes(String(item.id))) continue;
      const card = el("article", "agent-card");
      card.append(el("div", "agent-card-top", toText(item.id, "代理")));
      card.append(el("span", "agent-name", toText(firstValue(item, ["name", "role"]), "未命名代理")));
      card.append(el("p", "agent-extra", displayStatus(item.status)));
      container.append(card);
    }
  }

  function makeListCard(item, index, className, titleKeys, bodyKeys) {
    const card = el("article", `list-card ${className}`);
    const title = typeof item === "string" ? item : firstValue(item, titleKeys);
    const body = typeof item === "string" ? undefined : firstValue(item, bodyKeys);
    const fallback = isRecord(item) ? safeJson(item, true) : toText(item, `条目 ${index + 1}`);
    card.append(el("p", "list-card-title", title === undefined ? fallback : toText(title)));
    if (body !== undefined) card.append(el("p", "list-card-body", toText(body)));
    const metaValues = [];
    if (isRecord(item)) {
      if (item.id !== undefined) metaValues.push(`ID ${toText(item.id)}`);
      if (item.agentId !== undefined) metaValues.push(`代理 ${toText(item.agentId)}`);
    }
    if (metaValues.length) card.append(el("div", "list-card-meta", metaValues.join(" · ")));
    return card;
  }

  function renderSources(sources) {
    const container = $("resultSourceList");
    clear(container);
    const items = asArray(sources);
    $("resultSourceCount").textContent = `${items.length} 项`;
    const map = new Map();
    if (items.length === 0) {
      container.append(el("p", "empty-note", "当前运行快照没有来源记录。"));
      return map;
    }
    items.forEach((source, index) => {
      const id = sourceId(source, index);
      map.set(id, index);
      const card = el("article", "result-source-card");
      card.id = `evidence-source-${index}`;
      const heading = el("div", "result-source-heading");
      heading.append(el("span", "source-id", id));
      heading.append(el("strong", "", sourceTitle(source, index)));
      card.append(heading);
      card.append(el("p", "", sourceText(source)));
      container.append(card);
    });
    return map;
  }

  function renderFindings(findings, sourceMap) {
    const container = $("findingList");
    clear(container);
    const items = asArray(findings);
    if (items.length === 0) {
      container.append(el("p", "empty-note", "当前没有发现记录。"));
      return;
    }
    items.forEach((item, index) => {
      const card = makeListCard(item, index, "finding-card", ["summary", "title", "name"], ["detail", "message"]);
      if (isRecord(item)) {
        const refs = asArray(item.sourceIds);
        if (refs.length) {
          const links = el("div", "source-links");
          refs.forEach((ref, refIndex) => {
            const id = isRecord(ref) ? toText(firstValue(ref, ["id", "sourceId"])) : String(ref);
            const targetIndex = sourceMap.get(id);
            if (targetIndex === undefined) {
              links.append(el("span", "source-missing", `未匹配来源：${id || `第 ${refIndex + 1} 项`}`));
              return;
            }
            const link = el("a", "source-link", sourceTitle(asArray(state.snapshot?.sources)[targetIndex], targetIndex));
            link.href = `#evidence-source-${targetIndex}`;
            link.id = `finding-source-link-${index}-${refIndex}`;
            links.append(link);
          });
          card.append(links);
        }
      }
      container.append(card);
    });
  }

  function renderUnresolved(items) {
    const container = $("unresolvedList");
    clear(container);
    const rows = asArray(items);
    $("unresolvedCount").textContent = `${rows.length} 项`;
    if (!rows.length) {
      container.append(el("p", "empty-note", "当前快照没有待确认事项。"));
      return;
    }
    rows.forEach((item, index) => container.append(makeListCard(item, index, "open-item", ["summary", "title", "name"], ["detail", "question", "reason"])));
  }

  function renderDecisions(items) {
    const container = $("decisionList");
    clear(container);
    const rows = asArray(items);
    $("decisionCount").textContent = `${rows.length} 项`;
    if (!rows.length) {
      container.append(el("p", "empty-note", "当前快照没有决策记录。"));
      return;
    }
    rows.forEach((item, index) => container.append(makeListCard(item, index, "decision-card", ["summary", "title", "name"], ["detail", "rationale", "reason"])));
  }

  function renderChecks(items) {
    const container = $("checkList");
    clear(container);
    const rows = asArray(items);
    $("checkCount").textContent = `${rows.length} 项`;
    if (!rows.length) {
      container.append(el("p", "empty-note", "当前快照没有检查结果。"));
      return;
    }
    rows.forEach((item, index) => {
      const card = el("article", "list-card check-card");
      const status = isRecord(item) ? item.status : undefined;
      const normalized = typeof status === "string" ? status.toLowerCase() : "";
      const stateClass = normalized === "pass" ? "state-pass" : normalized === "fail" ? "state-fail" : normalized === "unknown" ? "state-unknown" : "";
      card.append(el("span", `check-state ${stateClass}`, displayStatus(status)));
      const body = el("div", "");
      const summary = typeof item === "string" ? item : firstValue(item, ["summary", "title", "name"]);
      const detail = isRecord(item) ? firstValue(item, ["detail", "message", "reason"]) : undefined;
      body.append(el("p", "list-card-title", summary === undefined ? toText(item, `检查 ${index + 1}`) : toText(summary)));
      if (detail !== undefined) body.append(el("p", "list-card-body", toText(detail)));
      card.append(body);
      container.append(card);
    });
  }

  function renderEvents(events) {
    const container = $("eventTimeline");
    clear(container);
    const rows = asArray(events);
    $("eventCount").textContent = `${rows.length} 项`;
    if (!rows.length) {
      container.append(el("li", "timeline-empty", "当前快照没有事件记录。"));
      return;
    }
    rows.forEach((item) => {
      const entry = el("li", "timeline-item");
      const when = isRecord(item) ? firstValue(item, ["at", "monotonicMs"]) : undefined;
      entry.append(el("time", "timeline-time", toText(when, "时间未记录")));
      const copy = el("div", "timeline-copy");
      const kind = isRecord(item) ? firstValue(item, ["type", "name"]) : item;
      copy.append(el("strong", "timeline-event", toText(kind, "事件")));
      const summary = isRecord(item) ? firstValue(item, ["summary", "message"]) : undefined;
      if (summary !== undefined) copy.append(el("div", "timeline-summary", toText(summary)));
      if (isRecord(item) && (item.agentId !== undefined || item.proposalVersion !== undefined || item.evidenceVersion !== undefined)) {
        const versionParts = [];
        if (item.agentId !== undefined) versionParts.push(`代理 ${toText(item.agentId)}`);
        if (item.proposalVersion !== undefined) versionParts.push(`方案 v${toText(item.proposalVersion)}`);
        if (item.evidenceVersion !== undefined) versionParts.push(`证据 v${toText(item.evidenceVersion)}`);
        copy.append(el("div", "timeline-versions", versionParts.join(" · ")));
      }
      entry.append(copy);
      container.append(entry);
    });
  }

  function updateRunMeta(snapshot) {
    const status = snapshot?.status || "IDLE";
    const pill = $("runState");
    pill.textContent = displayStatus(status);
    pill.className = `status-pill ${status === "RUNNING" || status === "CREATED" ? "status-running" : status === "FINISHED" ? "status-finished" : status === "FAILED" ? "status-failed" : status === "STOPPED" ? "status-stopped" : "status-idle"}`;
    const mode = snapshot?.mode || state.config?.mode || "MOCK";
    setText("runMode", mode);
    setText("headerMode", mode === "MOCK" ? "MOCK · 本地模拟" : mode);
    setText("runId", snapshot?.runId);
    setText("proposalVersion", snapshot?.proposalVersion);
    setText("evidenceVersion", snapshot?.evidenceVersion);
    setText("acceptanceStatus", displayStatus(snapshot?.acceptance || "NOT_CHECKED"));
    const posts = snapshot?.counters?.generationPosts;
    setText("generationCount", Number.isFinite(posts) ? posts : "—");
  }

  function renderSnapshot(snapshot) {
    const root = $("resultsRoot");
    const focusedId = root.contains(document.activeElement) ? document.activeElement.id : "";
    state.snapshot = snapshot;
    updateRunMeta(snapshot);
    root.setAttribute("aria-busy", snapshot.status === "RUNNING" || snapshot.status === "CREATED" ? "true" : "false");
    const original = snapshot.original ?? state.sample?.original;
    renderPlanComparison(original, snapshot.proposal, snapshot.proposal !== undefined);
    $("planFootnote").textContent = snapshot.proposalVersion !== undefined
      ? `方案版本 ${toText(snapshot.proposalVersion)} · 证据版本 ${toText(snapshot.evidenceVersion)}。高亮仅表示字段内容变化。`
      : "当前快照尚未提供修订方案。";
    renderAttachment(snapshot.proposal ?? original, snapshot.attachment ?? state.sample?.attachment);
    renderAgents(snapshot.agents);
    const sourceMap = renderSources(snapshot.sources);
    renderFindings(snapshot.findings, sourceMap);
    renderUnresolved(snapshot.unresolved);
    renderDecisions(snapshot.decisions);
    renderChecks(snapshot.checks);
    renderEvents(snapshot.events);
    if (focusedId) {
      const next = document.getElementById(focusedId);
      if (next && typeof next.focus === "function") next.focus({ preventScroll: true });
    }
    state.renderedSignature = stableJson(snapshot);
    updateButtons();
  }

  function renderNoRun() {
    state.snapshot = null;
    state.renderedSignature = "";
    updateRunMeta(null);
    $("resultsRoot").setAttribute("aria-busy", "false");
    const original = state.sample?.original;
    renderPlanComparison(original, undefined, false);
    $("planFootnote").textContent = "尚无运行结果。修订字段将在方案生成后标出。";
    renderAttachment(original, state.sample?.attachment);
    renderAgents([]);
    const clearList = (id, message) => {
      const node = $(id);
      clear(node);
      node.append(el("p", "empty-note", message));
    };
    clearList("findingList", "运行后显示发现和来源链接。");
    clearList("resultSourceList", "暂无来源快照。");
    $("resultSourceCount").textContent = "0 项";
    clearList("unresolvedList", "暂无待确认事项。");
    clearList("decisionList", "运行后显示方案决策轨迹。");
    clearList("checkList", "运行后显示检查结果。");
    clearList("eventTimeline", "运行后显示事件轨迹。");
    $("unresolvedCount").textContent = "0 项";
    $("decisionCount").textContent = "0 项";
    $("checkCount").textContent = "0 项";
    $("eventCount").textContent = "0 项";
    updateButtons();
  }

  function updateSampleSelect(sampleIds) {
    const select = $("sampleSelect");
    clear(select);
    const samples = asArray(sampleIds).filter((sample) => isRecord(sample) && sample.id !== undefined);
    if (samples.length === 0) {
      const option = el("option", "", "服务未提供样本");
      option.value = "";
      select.append(option);
      select.disabled = true;
      state.selectedSampleId = "";
      return;
    }
    for (const sample of samples) {
      const option = el("option", "", toText(sample.title, toText(sample.id)));
      option.value = String(sample.id);
      select.append(option);
    }
    state.selectedSampleId = String(samples[0].id);
    select.value = state.selectedSampleId;
    select.disabled = false;
  }

  async function loadSample(sampleId) {
    const token = ++state.sampleLoadToken;
    state.sample = null;
    renderSampleSummary(null);
    if (!state.snapshot) renderNoRun();
    if (!sampleId) return;
    try {
      const sample = await requestJson(`/api/sample?id=${encodeURIComponent(sampleId)}`);
      if (token !== state.sampleLoadToken) return;
      if (!isRecord(sample)) throw new Error("invalid-sample");
      state.sample = sample;
      renderSampleSummary(sample);
      if (!state.snapshot) {
        renderPlanComparison(sample.original, undefined, false);
        renderAttachment(sample.original, sample.attachment);
      }
      updateButtons();
    } catch (error) {
      if (token !== state.sampleLoadToken) return;
      state.sample = null;
      renderSampleSummary(null);
      setActionStatus(`样本读取失败。${apiErrorMessage(error)}`, "error");
      updateButtons();
    }
  }

  function schedulePolling() {
    if (state.pollTimer) window.clearInterval(state.pollTimer);
    state.pollTimer = null;
    const status = state.snapshot?.status;
    if (status !== "RUNNING" && status !== "CREATED") return;
    state.pollTimer = window.setInterval(pollCurrentRun, 1000);
  }

  async function pollCurrentRun() {
    if (state.pollInFlight) return;
    state.pollInFlight = true;
    try {
      const current = await requestJson("/api/run");
      if (isRecord(current) && ["CREATED", "RUNNING", "FINISHED", "STOPPED", "FAILED"].includes(current.status)) {
        const signature = stableJson(current);
        if (signature !== state.renderedSignature) renderSnapshot(current);
        schedulePolling();
      } else if (isRecord(current) && current.status === "IDLE") {
        if (state.pollTimer) window.clearInterval(state.pollTimer);
        state.pollTimer = null;
      } else {
        throw new Error("invalid-snapshot");
      }
    } catch (error) {
      setActionStatus(`运行状态暂时无法更新。${apiErrorMessage(error)}`, "error");
    } finally {
      state.pollInFlight = false;
    }
  }

  async function startRun() {
    if (!state.selectedSampleId || state.actionInFlight || !state.config || state.config.mode !== "MOCK") return;
    if (state.pollTimer) window.clearInterval(state.pollTimer);
    state.pollTimer = null;
    state.renderedSignature = "";
    renderNoRun();
    setActionStatus("正在创建 MOCK 运行…");
    setBusy(true);
    try {
      const snapshot = await requestJson("/api/runs", {
        method: "POST",
        body: JSON.stringify({ sampleId: state.selectedSampleId })
      });
      if (!isRecord(snapshot) || !["CREATED", "RUNNING", "FINISHED", "STOPPED", "FAILED"].includes(snapshot.status)) {
        throw new Error("invalid-snapshot");
      }
      renderSnapshot(snapshot);
      setActionStatus("运行已由本地服务创建；页面会每秒读取运行快照。", "success");
      schedulePolling();
    } catch (error) {
      renderNoRun();
      setActionStatus(`未能创建运行。${apiErrorMessage(error)}`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function stopRun() {
    if (!state.snapshot || state.actionInFlight) return;
    setActionStatus("正在请求停止运行…");
    setBusy(true);
    try {
      const snapshot = await requestJson("/api/stop", { method: "POST", body: "{}" });
      if (!isRecord(snapshot) || !["CREATED", "RUNNING", "FINISHED", "STOPPED", "FAILED"].includes(snapshot.status)) {
        throw new Error("invalid-snapshot");
      }
      renderSnapshot(snapshot);
      setActionStatus(snapshot.status === "STOPPED" ? "服务已返回停止状态。" : "停止请求已返回；页面将继续读取当前快照。", "success");
      schedulePolling();
    } catch (error) {
      setActionStatus(`停止请求未完成。${apiErrorMessage(error)}`, "error");
      schedulePolling();
    } finally {
      setBusy(false);
    }
  }

  function isFrozenBundle(value) {
    const bundle = isRecord(value) && isRecord(value.bundle) ? value.bundle : value;
    return isRecord(bundle)
      && bundle.schemaVersion !== undefined
      && typeof bundle.mode === "string"
      && typeof bundle.runId === "string"
      && isRecord(bundle.snapshot)
      && bundle.snapshot.artifactStatus === "FROZEN"
      && isRecord(bundle.manifest)
      && Object.keys(bundle.manifest).length > 0;
  }

  function downloadBundle(response) {
    const bundle = isRecord(response) && isRecord(response.bundle) ? response.bundle : response;
    const filePart = String(bundle.runId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "run";
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = el("a", "", "下载冻结包");
    link.href = url;
    link.download = `planpatch-${filePart}.json`;
    link.style.position = "fixed";
    link.style.left = "-10000px";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return link.download;
  }

  async function freezeRun() {
    if (!state.snapshot || state.snapshot.status === "RUNNING" || state.snapshot.status === "CREATED" || state.snapshot.artifactStatus !== "CANDIDATE" || state.actionInFlight) return;
    setActionStatus("正在请求服务冻结并返回导出包…");
    setBusy(true);
    try {
      const result = await requestJson("/api/freeze", { method: "POST", body: "{}" });
      if (!isFrozenBundle(result)) {
        throw new Error("invalid-bundle");
      }
      const bundle = isRecord(result.bundle) ? result.bundle : result;
      const filename = downloadBundle(result);
      state.downloadedRunId = bundle.runId;
      renderSnapshot(bundle.snapshot);
      setActionStatus(`服务已返回冻结包并触发下载：${filename}`, "success");
    } catch (error) {
      const detail = error && error.message === "invalid-bundle"
        ? "服务返回内容未满足冻结包结构；未触发下载。"
        : `冻结或导出失败。${apiErrorMessage(error)}`;
      setActionStatus(detail, "error");
    } finally {
      setBusy(false);
    }
  }

  async function initialize() {
    setActionStatus("正在连接本地服务并读取样本…");
    try {
      const config = await requestJson("/api/config");
      if (!isRecord(config)) throw new Error("invalid-config");
      state.config = config;
      updateSampleSelect(config.sampleIds);
      setText("headerMode", config.mode === "MOCK" ? "MOCK · 本地模拟" : toText(config.mode));
      updateButtons();
      if (config.mode !== "MOCK" || config.liveEnabled === true) {
        setActionStatus("服务配置与当前 MOCK 工作台边界不一致；运行操作已停用。", "error");
      } else if (state.selectedSampleId) {
        setActionStatus("本地样本列表已加载。", "success");
      } else {
        setActionStatus("本地服务未提供可用样本。", "error");
      }

      const selectedId = state.selectedSampleId;
      if (selectedId) await loadSample(selectedId);

      try {
        const current = await requestJson("/api/run");
        if (isRecord(current) && ["CREATED", "RUNNING", "FINISHED", "STOPPED", "FAILED"].includes(current.status)) {
          renderSnapshot(current);
          schedulePolling();
        } else if (isRecord(current) && current.status === "IDLE") {
          renderNoRun();
        } else {
          throw new Error("invalid-snapshot");
        }
      } catch {
        setActionStatus("样本已读取，但当前运行状态未能读取。", "error");
      }
    } catch (error) {
      state.config = null;
      updateSampleSelect([]);
      setText("headerMode", "本地服务不可用");
      setActionStatus(`无法加载工作台。${apiErrorMessage(error)}`, "error");
      renderNoRun();
    }
  }

  $("sampleSelect").addEventListener("change", (event) => {
    state.selectedSampleId = event.currentTarget.value;
    setActionStatus("正在读取所选样本…");
    loadSample(state.selectedSampleId);
  });
  $("startButton").addEventListener("click", startRun);
  $("stopButton").addEventListener("click", stopRun);
  $("freezeButton").addEventListener("click", freezeRun);

  initialize();
})();
