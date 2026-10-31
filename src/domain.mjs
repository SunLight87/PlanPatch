/** PlanPatch policy. Sources are data; only these narrow, inspectable rules infer facts. */
export const PLAN_FIELDS = ['title', 'date', 'time', 'location', 'capacity', 'registered', 'waitlist', 'weatherBackup'];
export const ATTACHMENT_FIELDS = ['time', 'capacity', 'registered', 'waitlist'];
export const MAX_INPUT_TEXT_CHARACTERS = 6000; // Sum of allowlisted string values, in JS UTF-16 code units.
const MUTABLE_FIELDS = new Set(['time', 'capacity', 'registered', 'waitlist', 'weatherBackup']);
export const clone = value => structuredClone(value);
export function codedError(code) { return Object.assign(new Error(code), { code }); }
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export function normalizeInput(input) {
  if (!input || input.synthetic !== true || typeof input.id !== 'string' || typeof input.title !== 'string') throw codedError('INVALID_INPUT');
  if (!input.id.trim() || input.id.length > 120 || !input.title.trim() || input.title.length > 500) throw codedError('INVALID_INPUT_TEXT');
  const copyFields = (source, fields) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw codedError('INVALID_PLAN');
    const result = {};
    for (const field of fields) {
      const value = source[field];
      if (['capacity', 'registered', 'waitlist'].includes(field)) {
        if (!Number.isSafeInteger(value) || value < 0 || value > 1000000) throw codedError('INVALID_COUNT');
      } else if (typeof value !== 'string' || value.length > 2000) throw codedError('INVALID_PLAN_TEXT');
      result[field] = value;
    }
    return result;
  };
  if (!Array.isArray(input.sources) || input.sources.length > 3) throw codedError('INVALID_SOURCES');
  const ids = new Set();
  const sources = input.sources.map(source => {
    if (!source || typeof source.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(source.id)
      || ids.has(source.id) || typeof source.title !== 'string' || source.title.length > 500
      || typeof source.text !== 'string' || source.text.length > 12000) throw codedError('INVALID_SOURCE');
    ids.add(source.id);
    return { id: source.id, title: source.title, text: source.text };
  });
  if (input.constraints !== undefined && (!Array.isArray(input.constraints) || input.constraints.length > 30
    || input.constraints.some(value => typeof value !== 'string' || value.length > 2000))) throw codedError('INVALID_CONSTRAINTS');
  // Allowlist deliberately excludes expected, tools, mode, paths and all other instructions.
  const result = { id: input.id, title: input.title, synthetic: true,
    original: copyFields(input.original, PLAN_FIELDS), attachment: copyFields(input.attachment, ATTACHMENT_FIELDS),
    sources, constraints: [...(input.constraints ?? [])] };
  const textLength = value => typeof value === 'string' ? value.length : value && typeof value === 'object'
    ? Object.values(value).reduce((sum, item) => sum + textLength(item), 0) : 0;
  if (textLength(result) > MAX_INPUT_TEXT_CHARACTERS) throw codedError('INPUT_TEXT_LIMIT_EXCEEDED');
  return deepFreeze(result);
}

const isUnknownBackup = value => /待确认|未确认|尚未|未知|unknown|pending|unconfirmed|not\s+(?:yet\s+)?confirmed/i.test(value);
function normalizedTime(value) {
  const match = String(value).match(/(\d{1,2}):([0-5]\d)\s*[-–—~～至到]\s*(\d{1,2}):([0-5]\d)/);
  if (!match) return undefined;
  const [, h1, m1, h2, m2] = match;
  if (+h1 > 23 || +h2 > 23 || +h1 * 60 + +m1 >= +h2 * 60 + +m2) return undefined;
  return `${h1.padStart(2, '0')}:${m1}–${h2.padStart(2, '0')}:${m2}`;
}
const equivalent = (field, a, b) => field === 'time' ? (normalizedTime(a) ?? a) === (normalizedTime(b) ?? b) : a === b;

export function extractEvidence(sources) {
  const observations = [];
  const add = (field, value, source, quote) => observations.push({ field, value, sourceId: source.id, quote });
  for (const source of sources) {
    for (const sentence of source.text.split(/[。！？!\n]+/).map(text => text.trim()).filter(Boolean)) {
      // Historical/negated arrangements are not current evidence. Imperatives never gain authority.
      if (/不能使用|原来|原方案|旧安排|previous|formerly|old\s+(?:time|capacity)|ignore\s+(?:previous|all)|system\s*prompt|开发者指令/i.test(sentence)) continue;
      const capacity = sentence.match(/(?:capacity|可容纳|容纳(?:人数)?(?:上限)?|人数上限|名额上限)\s*(?:为|是|[:：=])?\s*(\d{1,7})/i);
      if (capacity && +capacity[1] <= 1000000) add('capacity', +capacity[1], source, sentence);
      const registered = sentence.match(/(?:registrations|registered|registration\s+count|已登记报名|已报名|报名人数|报名)\s*(?:人数|count)?\s*(?:为|是|[:：=])?\s*(\d{1,7})/i);
      if (registered && +registered[1] <= 1000000) add('registered', +registered[1], source, sentence);
      if (/time|时段|时间|可用/i.test(sentence)) {
        const time = normalizedTime(sentence);
        if (time) add('time', time, source, sentence);
      }
      if (/backup|雨天|备用/i.test(sentence)) {
        if (isUnknownBackup(sentence) || /没有.*确认|no\s+confirmed/i.test(sentence)) add('weatherBackup', '待确认', source, sentence);
        else {
          const confirmed = sentence.match(/(?:weatherBackup|backup|备用安排|备用场地)\s*[:：=]\s*(.+)/i);
          if (confirmed && !/不得|不能|do\s+not/i.test(sentence)) add('weatherBackup', confirmed[1].trim(), source, sentence);
        }
      }
    }
  }
  const facts = [], conflicts = [];
  for (const field of ['time', 'capacity', 'registered', 'weatherBackup']) {
    const matches = observations.filter(item => item.field === field);
    const values = [...new Set(matches.map(item => item.value))];
    const sourceIds = [...new Set(matches.map(item => item.sourceId))];
    if (values.length > 1) conflicts.push({ field, values, sourceIds, summary: `${field} 的来源互相冲突，需人工核实。` });
    else if (values.length === 1) facts.push({ field, value: values[0], sourceIds,
      quotes: matches.map(item => ({ sourceId: item.sourceId, text: item.quote })) });
  }
  const unknowns = [];
  if (!facts.some(item => item.field === 'weatherBackup' && !isUnknownBackup(item.value))) {
    unknowns.push({ id: 'weather-backup', summary: '雨天备用安排缺少一致的确认材料，仍待确认。',
      sourceIds: facts.filter(item => item.field === 'weatherBackup').flatMap(item => item.sourceIds) });
  }
  for (const conflict of conflicts) unknowns.push({ id: `conflict-${conflict.field}`, ...conflict });
  return { facts, conflicts, unknowns };
}

export function evidenceFindings(evidence, proposal) {
  const findings = evidence.facts.map(fact => ({ id: `fact-${fact.field}`, agentId: 'A', field: fact.field,
    value: fact.value, sourceIds: fact.sourceIds, quotes: fact.quotes,
    summary: `${fact.field}：材料记载为 ${fact.value}${equivalent(fact.field, proposal[fact.field], fact.value) ? '，与方案一致' : '，与当前方案不同'}。` }));
  return [...findings, ...evidence.conflicts.map(item => ({ id: `conflict-${item.field}`, agentId: 'A', ...item }))];
}

/** Build a minimal batch against the snapshot actually read by C, never an expected oracle. */
export function proposeRevision(view) {
  const evidence = view.evidence ?? { facts: [], conflicts: [] };
  const proposal = clone(view.proposal), attachment = clone(view.attachment), reasons = new Map();
  for (const fact of evidence.facts) {
    if (fact.field === 'weatherBackup' && isUnknownBackup(fact.value) && isUnknownBackup(proposal.weatherBackup)) continue;
    if (!equivalent(fact.field, proposal[fact.field], fact.value)) proposal[fact.field] = fact.value;
    reasons.set(fact.field, { sourceIds: fact.sourceIds, reason: '按已识别且无冲突的材料事实修订。' });
  }
  if (!evidence.conflicts.some(item => ['capacity', 'registered'].includes(item.field))) {
    proposal.waitlist = Math.max(0, proposal.registered - proposal.capacity);
    reasons.set('waitlist', { sourceIds: [...new Set(evidence.facts.filter(item => ['capacity', 'registered'].includes(item.field)).flatMap(item => item.sourceIds))],
      reason: '候补人数 = max(0, 报名人数 - 容量)；缺少新材料的数字沿用声明的原方案。',
      inputRefs: ['original.capacity', 'original.registered'] });
  }
  for (const field of ATTACHMENT_FIELDS) attachment[field] = proposal[field];
  const changes = [];
  for (const [target, before, after] of [['proposal', view.proposal, proposal], ['attachment', view.attachment, attachment]]) {
    for (const field of Object.keys(after)) if (!equivalent(field, before[field], after[field])) {
      changes.push({ target, field, before: before[field], after: after[field],
        ...(reasons.get(field) ?? { sourceIds: [], inputRefs: [`proposal.${field}`], reason: '附件与当前方案同步。' }) });
    }
  }
  return { baseProposalVersion: view.proposalVersion, baseEvidenceVersion: view.evidenceVersion, changes };
}

export function affectedRequirements(changes) {
  const ids = new Set();
  for (const change of changes) {
    if (['time', 'capacity'].includes(change.field)) ids.add('venue');
    if (['capacity', 'registered', 'waitlist'].includes(change.field)) ids.add('registrations');
    if (change.target === 'attachment' || ATTACHMENT_FIELDS.includes(change.field)) ids.add('attachment');
    if (change.field === 'weatherBackup') ids.add('weather-backup');
  }
  return [...ids];
}
export const versionsMatch = (state, output) => output.baseProposalVersion === state.proposalVersion && output.baseEvidenceVersion === state.evidenceVersion;

/** Only the coordinator calls this writer; validation is atomic, including held rechecks. */
export function applyVersionedPatch(state, patch, reservation) {
  if (!versionsMatch(state, patch)) return { applied: false, code: 'STALE_PATCH' };
  if (!Array.isArray(patch.changes)) return { applied: false, code: 'INVALID_PATCH' };
  const affected = affectedRequirements(patch.changes);
  if (affected.length && (!reservation || affected.some(id => !reservation.requirements?.includes(id)))) return { applied: false, code: 'RECHECK_BUDGET_REQUIRED' };
  const allowed = proposeRevision(state).changes;
  const seen = new Set();
  for (const change of patch.changes) {
    const key = `${change.target}.${change.field}`;
    if (!['proposal', 'attachment'].includes(change.target) || !MUTABLE_FIELDS.has(change.field) || seen.has(key)
      || !allowed.some(item => JSON.stringify(item) === JSON.stringify(change))
      || !Object.is(state[change.target][change.field], change.before)) return { applied: false, code: 'UNSUPPORTED_PATCH' };
    seen.add(key);
  }
  if (!patch.changes.length) return { applied: false, code: 'NO_CHANGE', affected: [] };
  for (const change of patch.changes) state[change.target][change.field] = clone(change.after);
  state.proposalVersion++;
  state.checks = []; // Every published check must belong to the current proposal AND evidence.
  return { applied: true, affected };
}

export function evaluateChecks(view, requirements = ['all']) {
  // B can read its own source snapshot while A is still working; it need not wait for A's cache.
  const evidence = view.evidence?.facts?.length || view.evidence?.conflicts?.length
    ? view.evidence : extractEvidence(view.sources ?? []);
  const fact = field => evidence.facts.find(item => item.field === field);
  const conflict = fields => evidence.conflicts.some(item => fields.includes(item.field));
  const checks = [];
  const add = (id, status, summary, sourceIds = []) => checks.push({ id, status, summary, sourceIds });
  const venueFacts = evidence.facts.filter(item => ['time', 'capacity'].includes(item.field));
  add('venue', conflict(['time', 'capacity']) ? 'UNKNOWN'
    : venueFacts.some(item => !equivalent(item.field, view.proposal[item.field], item.value)) ? 'FAIL'
      : venueFacts.length === 2 ? 'PASS' : 'UNKNOWN', '检查场地时间与容量是否符合一致材料。', venueFacts.flatMap(item => item.sourceIds));
  add('registrations', conflict(['capacity', 'registered']) ? 'UNKNOWN'
    : view.proposal.waitlist !== Math.max(0, view.proposal.registered - view.proposal.capacity)
      || (fact('registered') && fact('registered').value !== view.proposal.registered) ? 'FAIL' : 'PASS',
  `报名 ${view.proposal.registered} 人，容量 ${view.proposal.capacity} 人，候补 ${view.proposal.waitlist} 人。`,
  evidence.facts.filter(item => ['capacity', 'registered'].includes(item.field)).flatMap(item => item.sourceIds));
  add('attachment', ATTACHMENT_FIELDS.every(field => equivalent(field, view.proposal[field], view.attachment[field])) ? 'PASS' : 'FAIL', '方案与报名附件的时间及人数逐项核对。');
  const backup = fact('weatherBackup');
  add('weather-backup', conflict(['weatherBackup']) || !backup || isUnknownBackup(backup.value)
    ? (isUnknownBackup(view.proposal.weatherBackup) ? 'UNKNOWN' : 'FAIL')
    : view.proposal.weatherBackup === backup.value ? 'PASS' : 'FAIL',
  '备用安排需要明确且一致的确认材料；待确认不计为通过。', backup?.sourceIds ?? []);
  add('source-conflicts', evidence.conflicts.length ? 'UNKNOWN' : 'PASS', evidence.conflicts.length ? '存在来源冲突，保持未解决。' : '已识别的结构化事实没有来源冲突。');
  // Free-text constraints are retained for a human: a narrow mock parser cannot certify arbitrary rules.
  if (view.constraints?.length) add('declared-constraints', 'UNKNOWN', '输入中的自由文本约束已保留，需人工核对；MOCK 不声称完成语义验收。');
  return { baseProposalVersion: view.proposalVersion, baseEvidenceVersion: view.evidenceVersion,
    checks: requirements.includes('all') ? checks : checks.filter(item => requirements.includes(item.id)) };
}

export function applyVersionedChecks(state, output) {
  if (!versionsMatch(state, output)) return { applied: false, code: 'STALE_CHECK' };
  if (!Array.isArray(output.checks) || new Set(output.checks.map(check => check.id)).size !== output.checks.length) return { applied: false, code: 'INVALID_CHECK' };
  const expected = evaluateChecks(state).checks;
  if (output.checks.some(check => !expected.some(item => JSON.stringify(item) === JSON.stringify(check)))) return { applied: false, code: 'UNSUPPORTED_CHECK' };
  const ids = new Set(output.checks.map(check => check.id));
  state.checks = [...state.checks.filter(check => !ids.has(check.id)), ...clone(output.checks).map(check => ({ ...check,
    proposalVersion: state.proposalVersion, evidenceVersion: state.evidenceVersion }))];
  return { applied: true };
}
