(() => {
  "use strict";

  const KEYS = {
    program: "garage531.program.v1",
    state: "garage531.state.v1",
    current: "garage531.current.v1",
    history: "garage531.history.v1",
    sourceUrl: "garage531.sourceUrl.v1"
  };

  let programYaml = "";
  let program = null;
  let appState = null;
  let currentWorkout = null;
  let history = [];
  let timerHandle = null;
  let toastHandle = null;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bindStaticEvents();
    updateConnectionStatus();
    window.addEventListener("online", updateConnectionStatus);
    window.addEventListener("offline", updateConnectionStatus);

    history = readJson(KEYS.history, []);
    currentWorkout = readJson(KEYS.current, null);

    try {
      const stored = localStorage.getItem(KEYS.program);
      programYaml = stored || await fetchBundledProgram();
      program = parseAndValidate(programYaml);
      if (!stored) localStorage.setItem(KEYS.program, programYaml);
    } catch (error) {
      showFatalProgramError(error);
      return;
    }

    appState = readJson(KEYS.state, null) || initialAppState(program);
    reconcileAppState();
    ensureActiveInterval();
    if (currentWorkout) saveJson(KEYS.current, currentWorkout);
    $("#program-editor").value = programYaml;
    $("#program-url").value = localStorage.getItem(KEYS.sourceUrl) || "";

    populateSelectors();
    renderAll();
    registerServiceWorker();
  }

  function bindStaticEvents() {
    $$(".nav-button").forEach(button => button.addEventListener("click", () => showView(button.dataset.view)));
    $("#week-select").addEventListener("change", event => updateSelection("week", event.target.value));
    $("#day-select").addEventListener("change", event => updateSelection("day", event.target.value));
    $("#start-workout").addEventListener("click", startWorkout);
    $("#resume-workout").addEventListener("click", () => showView("workout"));
    $("#pause-workout").addEventListener("click", togglePause);
    $("#finish-workout").addEventListener("click", finishWorkout);
    $("#discard-workout").addEventListener("click", discardWorkout);
    $("#restart-set-timer").addEventListener("click", restartCurrentInterval);
    $("#workout-sections").addEventListener("change", handleWorkoutChange);
    $("#workout-sections").addEventListener("input", handleWorkoutInput);
    $("#program-file").addEventListener("change", importProgramFile);
    $("#load-program-url").addEventListener("click", loadProgramUrl);
    $("#activate-program").addEventListener("click", activateEditorProgram);
    $("#reset-program").addEventListener("click", resetBundledProgram);
    $("#export-yaml").addEventListener("click", exportYaml);
    $("#export-backup").addEventListener("click", exportBackup);
    $("#backup-file").addEventListener("change", importBackup);
    $("#reload-app").addEventListener("click", () => location.reload());
  }

  async function fetchBundledProgram() {
    const response = await fetch("program.yaml", { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load program.yaml (${response.status}).`);
    return response.text();
  }

  function parseAndValidate(text) {
    let parsed;
    try {
      parsed = jsyaml.load(text);
    } catch (error) {
      throw new Error(`YAML syntax error: ${error.message}`);
    }

    const errors = validateProgram(parsed);
    if (errors.length) throw new Error(errors.join("\n"));
    return parsed;
  }

  function validateProgram(candidate) {
    const errors = [];
    if (!candidate || typeof candidate !== "object") return ["The YAML must contain an object."];
    for (const key of ["reference_weights", "app_defaults", "prescriptions", "plan"]) {
      if (!candidate[key]) errors.push(`Missing required section: ${key}`);
    }
    if (errors.length) return errors;

    const prescriptions = candidate.prescriptions;
    const warmups = prescriptions.warmups || {};
    const plan = candidate.plan || {};
    const days = Object.keys(plan);
    const weightNames = new Set(Object.values(candidate.reference_weights).flatMap(flattenWeightNames));

    for (const [day, entries] of Object.entries(plan)) {
      if (!Array.isArray(entries)) {
        errors.push(`${day} must be a list of exercises.`);
        continue;
      }
      entries.forEach((entry, index) => {
        const where = `${day}, entry ${index + 1}`;
        if (!entry.exercise) errors.push(`${where}: missing exercise.`);
        if (!entry.prescription) errors.push(`${where}: missing prescription.`);
        if (entry.prescription && !prescriptions[entry.prescription]) errors.push(`${where}: unknown prescription ${entry.prescription}.`);
        if (entry.warmup && !warmups[entry.warmup]) errors.push(`${where}: unknown warm-up ${entry.warmup}.`);
        if (entry.exercise && !weightNames.has(entry.exercise) && !isBodyweight(entry.exercise)) {
          errors.push(`${where}: ${entry.exercise} has no reference weight.`);
        }
      });
    }

    const periodized = prescriptions["5-3-1"];
    if (!periodized || !Array.isArray(periodized.weeks)) {
      errors.push("The 5-3-1 prescription must define weeks.");
    } else {
      periodized.weeks.forEach(week => {
        if (!week.name || !Array.isArray(week.sets)) errors.push("Every 5-3-1 week needs a name and sets.");
        if (week.warmup && !warmups[week.warmup]) errors.push(`Week ${week.name} uses unknown warm-up ${week.warmup}.`);
      });
      const weekNames = periodized.weeks.map(week => week.name);
      const initialWeek = candidate.app_defaults?.initial_state?.week;
      if (initialWeek && !weekNames.includes(initialWeek)) errors.push(`Initial week ${initialWeek} is not defined.`);
    }

    const dayOrder = candidate.app_defaults?.day_order || [];
    dayOrder.forEach(day => { if (!days.includes(day)) errors.push(`day_order contains unknown day ${day}.`); });
    days.forEach(day => { if (!dayOrder.includes(day)) errors.push(`day_order is missing ${day}.`); });
    return errors;
  }

  function flattenWeightNames(value) {
    if (Array.isArray(value)) return value.flatMap(item => Object.keys(item || {}));
    if (value && typeof value === "object") return Object.keys(value);
    return [];
  }

  function weightMap(section) {
    const value = program.reference_weights[section] || {};
    if (!Array.isArray(value)) return { ...value };
    return Object.assign({}, ...value);
  }

  function isBodyweight(name) {
    return ["plank", "side_plank", "chin_up"].includes(name);
  }

  function initialAppState(candidate) {
    const initial = candidate.app_defaults.initial_state || {};
    return {
      week: initial.week || candidate.prescriptions["5-3-1"].weeks[0].name,
      day: initial.day || candidate.app_defaults.day_order[0]
    };
  }

  function reconcileAppState() {
    const weeks = program.prescriptions["5-3-1"].weeks.map(week => week.name);
    const days = program.app_defaults.day_order;
    if (!weeks.includes(appState.week)) appState.week = program.app_defaults.initial_state.week;
    if (!days.includes(appState.day)) appState.day = program.app_defaults.initial_state.day;
    saveJson(KEYS.state, appState);
  }

  function populateSelectors() {
    const weekSelect = $("#week-select");
    const daySelect = $("#day-select");
    weekSelect.innerHTML = program.prescriptions["5-3-1"].weeks
      .map(week => `<option value="${escapeHtml(week.name)}">${escapeHtml(titleCase(week.name))}</option>`).join("");
    daySelect.innerHTML = program.app_defaults.day_order
      .map(day => `<option value="${escapeHtml(day)}">${escapeHtml(dayLabel(day))}</option>`).join("");
    weekSelect.value = appState.week;
    daySelect.value = appState.day;
  }

  function updateSelection(field, value) {
    appState[field] = value;
    saveJson(KEYS.state, appState);
    renderHome();
  }

  function renderAll() {
    renderHome();
    renderWorkout();
    renderHistory();
    updateProgramStatus("Valid program", false, true);
  }

  function renderHome() {
    const preview = buildWorkout(appState.week, appState.day, true);
    $("#home-estimate").textContent = formatDuration(preview.plannedSeconds);
    $("#home-program-status").textContent = `${preview.totalSets} sets`;
    const resumeCard = $("#resume-card");
    if (currentWorkout) {
      resumeCard.classList.remove("is-hidden");
      $("#resume-title").textContent = `${dayLabel(currentWorkout.day)} · ${titleCase(currentWorkout.week)}`;
      $("#resume-detail").textContent = `${completionStats(currentWorkout).done} of ${completionStats(currentWorkout).total} sets complete`;
      $("#start-workout").textContent = "Start another workout";
    } else {
      resumeCard.classList.add("is-hidden");
      $("#start-workout").textContent = "Start workout";
    }
  }

  function startWorkout() {
    if (currentWorkout && !confirm("Discard the unfinished workout and start another one?")) return;
    currentWorkout = buildWorkout(appState.week, appState.day, false);
    startNextPendingInterval(null, currentWorkout.startedAt);
    saveJson(KEYS.current, currentWorkout);
    renderAll();
    showView("workout");
  }

  function buildWorkout(weekName, dayName, previewOnly) {
    const entries = program.plan[dayName];
    const expanded = entries.map(entry => expandExercise(entry, weekName));
    const sections = [];

    for (let index = 0; index < expanded.length;) {
      const item = expanded[index];
      if (item.superset) {
        const members = [];
        while (index < expanded.length && expanded[index].superset === item.superset) {
          members.push(expanded[index]);
          index += 1;
        }
        sections.push({ kind: "superset", id: item.superset, members });
      } else {
        sections.push({ kind: "exercise", member: item });
        index += 1;
      }
    }

    const timing = program.app_defaults.timing || {};
    const warmupSeconds = timing.warmup_set_interval || 120;
    const workSeconds = timing.work_set_interval || 180;
    const supersetSeconds = timing.superset_round_interval || workSeconds;
    let warmupCount = 0;
    let workIntervals = 0;

    sections.forEach(section => {
      if (section.kind === "exercise") {
        warmupCount += section.member.warmups.length;
        workIntervals += section.member.workSets.length;
      } else {
        warmupCount += Math.max(...section.members.map(member => member.warmups.length));
        workIntervals += Math.max(...section.members.map(member => member.workSets.length));
      }
    });

    const totalSets = sections.reduce((sum, section) => sum + sectionSets(section).length, 0);
    return {
      id: previewOnly ? "preview" : makeId(),
      week: weekName,
      day: dayName,
      startedAt: previewOnly ? null : Date.now(),
      pausedAt: null,
      totalPausedMs: 0,
      activeInterval: null,
      plannedSeconds: warmupCount * warmupSeconds + sections.reduce((sum, section) => {
        if (section.kind === "exercise") return sum + section.member.workSets.length * workSeconds;
        return sum + Math.max(...section.members.map(member => member.workSets.length)) * supersetSeconds;
      }, 0),
      totalSets,
      sections
    };
  }

  function expandExercise(entry, weekName) {
    const trainingMaxes = weightMap("training_max");
    const fixedWeights = { ...weightMap("non_programmed_weight"), ...weightMap("fixed_weight") };
    const trainingMax = trainingMaxes[entry.exercise] ?? null;
    const fixedWeight = fixedWeights[entry.exercise] ?? null;
    const prescription = program.prescriptions[entry.prescription];
    let workDefs = [];
    let workingWeight = fixedWeight;
    let weekDef = null;

    if (entry.prescription === "5-3-1") {
      weekDef = prescription.weeks.find(week => week.name === weekName);
      workDefs = weekDef.sets.map(set => ({ ...set }));
      if (entry.work_set_order === "descending") workDefs.reverse();
    } else if (Array.isArray(prescription)) {
      prescription.forEach(block => {
        for (let count = 0; count < block.sets; count += 1) workDefs.push({ ...block });
      });
    } else {
      const count = prescription.sets || 0;
      workingWeight = resolvePrescriptionWeight(prescription, trainingMax, weekName);
      for (let set = 0; set < count; set += 1) {
        workDefs.push({ reps: prescription.reps, duration: prescription.duration, measure: prescription.measure });
      }
    }

    const workSets = workDefs.map((definition, index) => createSet({
      definition,
      kind: "work",
      exercise: entry.exercise,
      index,
      weight: definition.percent != null ? rounded(trainingMax * definition.percent) : workingWeight
    }));

    const warmupName = weekDef?.warmup || entry.warmup;
    const warmup = warmupName ? program.prescriptions.warmups[warmupName] : null;
    const topPercent = weekDef ? Math.max(...weekDef.sets.map(set => set.percent || 0)) : null;
    const warmups = warmup ? warmup.sets.map((definition, index) => {
      let weight = null;
      if (definition.percent != null) {
        const basis = warmup.intensity_basis === "working_weight" ? workingWeight : trainingMax;
        weight = rounded(basis * definition.percent);
      } else if (definition.intensity?.method === "top_work_set_offset") {
        weight = rounded(trainingMax * (topPercent + definition.intensity.value));
      }
      return createSet({ definition, kind: "warmup", exercise: entry.exercise, index, weight });
    }) : [];

    return {
      exercise: entry.exercise,
      prescription: entry.prescription,
      superset: entry.superset || null,
      trainingMax,
      fixedWeight,
      warmupName,
      warmups,
      workSets
    };
  }

  function resolvePrescriptionWeight(prescription, trainingMax, weekName) {
    const method = prescription.intensity?.method;
    if (method === "percent_training_max") return rounded(trainingMax * prescription.intensity.value);
    if (method === "first_set_last") {
      const week = program.prescriptions["5-3-1"].weeks.find(item => item.name === weekName);
      const firstPercent = Math.min(...week.sets.map(set => set.percent));
      return rounded(trainingMax * firstPercent);
    }
    return null;
  }

  function createSet({ definition, kind, exercise, index, weight }) {
    const phases = Array.isArray(definition.phases) ? definition.phases.map(phase => ({
      name: phase.name,
      reps: Number(phase.reps) || 0
    })) : null;
    return {
      id: `${exercise}-${kind}-${index}-${makeId()}`,
      kind,
      exercise,
      reps: definition.reps ?? (phases ? phases.reduce((sum, phase) => sum + phase.reps, 0) : null),
      phases,
      duration: definition.duration ?? null,
      measure: definition.measure ?? null,
      percent: definition.percent ?? null,
      amrap: Boolean(definition.amrap),
      weight: weight ?? null,
      completed: false,
      actualReps: null,
      startedAt: null,
      completedAt: null,
      durationSeconds: null
    };
  }

  function rounded(value) {
    if (value == null || !Number.isFinite(value)) return null;
    const rule = program.app_defaults.rounding || { increment: 5, mode: "nearest", ties: "down" };
    const increment = rule.increment || 5;
    const quotient = value / increment;
    if (rule.mode === "down") return Math.floor(quotient) * increment;
    if (rule.mode === "up") return Math.ceil(quotient) * increment;
    const lower = Math.floor(quotient);
    const fraction = quotient - lower;
    const steps = Math.abs(fraction - 0.5) < 1e-9 && rule.ties === "down" ? lower : Math.round(quotient);
    return steps * increment;
  }

  function renderWorkout() {
    clearInterval(timerHandle);
    timerHandle = null;
    const container = $("#workout-sections");
    if (!currentWorkout) {
      $("#workout-title").textContent = "No active workout";
      $("#workout-week").textContent = "Choose a session from Today";
      container.innerHTML = `<div class="empty-state">Start a workout to see its sets here.</div>`;
      $("#finish-workout").disabled = true;
      $("#pause-workout").disabled = true;
      $("#restart-set-timer").disabled = true;
      $("#current-set-time").textContent = "—";
      $("#total-time").textContent = "0:00:00";
      $("#current-set-panel").classList.remove("is-ready");
      updateProgress();
      return;
    }

    $("#workout-title").textContent = dayLabel(currentWorkout.day);
    $("#workout-week").textContent = `${titleCase(currentWorkout.week)} week`;
    $("#pause-workout").disabled = false;
    $("#pause-workout").textContent = currentWorkout.pausedAt ? "Resume" : "Pause";
    $("#restart-set-timer").disabled = !currentWorkout.activeInterval || Boolean(currentWorkout.pausedAt);
    container.innerHTML = currentWorkout.sections.map(renderSection).join("");
    updateProgress();
    updateTimers();
    timerHandle = setInterval(updateTimers, 1000);
  }

  function renderSection(section) {
    if (section.kind === "exercise") return renderExerciseCard(section.member);
    const warmupRounds = Math.max(...section.members.map(member => member.warmups.length));
    const workRounds = Math.max(...section.members.map(member => member.workSets.length));
    const warmups = warmupRounds ? `<div class="set-group-label superset-label">Warm-up rounds</div>${renderSupersetRounds(section, "warmup", warmupRounds)}` : "";
    const work = `<div class="set-group-label superset-label">Work rounds</div>${renderSupersetRounds(section, "work", workRounds)}`;
    return `<article class="exercise-card">
      <div class="exercise-heading">
        <div><p class="eyebrow superset-label">Superset</p><h3>${escapeHtml(titleCase(section.id))}</h3></div>
        <span class="badge">${workRounds} rounds</span>
      </div>
      ${warmups}
      ${work}
    </article>`;
  }

  function renderSupersetRounds(section, kind, roundCount) {
    let html = "";
    for (let index = 0; index < roundCount; index += 1) {
      const intervalKey = `${section.id}-${kind}-${index}`;
      const active = currentWorkout?.activeInterval?.key === intervalKey;
      html += `<div class="round-heading ${active ? "is-active" : ""}">${kind === "warmup" ? "Warm-up" : "Round"} ${index + 1}</div>`;
      section.members.forEach(member => {
        const set = kind === "warmup" ? member.warmups[index] : member.workSets[index];
        if (set) html += renderSetRow(set, exerciseLabel(member.exercise), { intervalKey });
      });
    }
    return html;
  }

  function renderExerciseCard(member) {
    const warmup = member.warmups.length ? `<div class="set-group-label">Warm-up</div>${member.warmups.map(set => renderSetRow(set)).join("")}` : "";
    return `<article class="exercise-card">
      <div class="exercise-heading">
        <div><h3>${escapeHtml(exerciseLabel(member.exercise))}</h3><p>${escapeHtml(prescriptionLabel(member.prescription))}</p></div>
        ${member.trainingMax != null ? `<span class="badge">TM ${member.trainingMax}</span>` : member.fixedWeight != null ? `<span class="badge">${member.fixedWeight} lb</span>` : ""}
      </div>
      ${warmup}
      <div class="set-group-label">Work</div>
      ${member.workSets.map(set => renderSetRow(set)).join("")}
    </article>`;
  }

  function renderSetRow(set, exerciseName = "", options = {}) {
    const intervalKey = options.intervalKey || set.id;
    const phaseTarget = set.phases?.map(phase => `${phase.reps} ${phaseLabel(phase.name)}`).join(" + ");
    const target = set.duration != null ? `${set.duration} ${set.measure || "seconds"}` : phaseTarget || `${set.reps}${set.amrap ? "+" : ""} reps`;
    const load = set.weight != null ? `${set.weight} lb` : "Bodyweight";
    const detail = [exerciseName, set.percent != null ? `${Math.round(set.percent * 100)}%` : ""].filter(Boolean).join(" · ");
    const active = currentWorkout?.activeInterval?.key === intervalKey;
    const controls = set.amrap ? `<div class="amrap-control"><label for="reps-${escapeHtml(set.id)}">Actual</label><input id="reps-${escapeHtml(set.id)}" data-amrap-id="${escapeHtml(set.id)}" type="number" min="1" inputmode="numeric" value="${set.actualReps ?? ""}" placeholder="reps"></div>` : "";
    return `<div class="set-row ${set.completed ? "is-complete" : ""} ${active ? "is-active" : ""}" data-set-row="${escapeHtml(set.id)}">
      <input class="set-check" type="checkbox" data-set-id="${escapeHtml(set.id)}" data-interval-key="${escapeHtml(intervalKey)}" ${set.completed ? "checked" : ""} aria-label="Mark ${escapeHtml(target)} complete">
      <div class="set-main"><span class="set-weight">${escapeHtml(load)}</span> × ${escapeHtml(target)}${detail ? `<span class="set-detail">${escapeHtml(detail)}</span>` : ""}</div>
      ${controls ? `<div class="set-controls">${controls}</div>` : ""}
    </div>`;
  }

  function intervalSeconds(kind, isSuperset) {
    const timing = program.app_defaults.timing || {};
    if (kind === "warmup") return timing.warmup_set_interval || 120;
    if (isSuperset) return timing.superset_round_interval || timing.work_set_interval || 180;
    return timing.work_set_interval || 180;
  }

  function workoutIntervals(workout) {
    const intervals = [];
    workout.sections.forEach(section => {
      if (section.kind === "exercise") {
        [...section.member.warmups, ...section.member.workSets].forEach(set => {
          intervals.push({
            key: set.id,
            label: `${exerciseLabel(set.exercise)} ${set.kind}`,
            targetSeconds: intervalSeconds(set.kind, false),
            setIds: [set.id]
          });
        });
        return;
      }

      for (const kind of ["warmup", "work"]) {
        const collection = kind === "warmup" ? "warmups" : "workSets";
        const roundCount = Math.max(...section.members.map(member => member[collection].length));
        for (let index = 0; index < roundCount; index += 1) {
          const setIds = section.members.map(member => member[collection][index]?.id).filter(Boolean);
          intervals.push({
            key: `${section.id}-${kind}-${index}`,
            label: `${titleCase(section.id)} ${kind} ${index + 1}`,
            targetSeconds: intervalSeconds(kind, true),
            setIds
          });
        }
      }
    });
    return intervals;
  }

  function intervalIsComplete(workout, interval) {
    return interval.setIds.every(id => findSet(workout, id)?.completed);
  }

  function startInterval(interval, startedAt = Date.now()) {
    const pausedAt = currentWorkout.pausedAt ? startedAt : null;
    currentWorkout.activeInterval = {
      key: interval.key,
      label: interval.label,
      startedAt,
      targetSeconds: interval.targetSeconds,
      pausedMs: 0,
      pausedAt
    };
  }

  function startNextPendingInterval(afterKey = null, startedAt = Date.now()) {
    if (!currentWorkout) return;
    const intervals = workoutIntervals(currentWorkout);
    const currentIndex = afterKey == null ? -1 : intervals.findIndex(interval => interval.key === afterKey);
    const next = intervals.slice(currentIndex + 1).find(interval => !intervalIsComplete(currentWorkout, interval));
    if (next) startInterval(next, startedAt);
    else currentWorkout.activeInterval = null;
  }

  function ensureActiveInterval() {
    if (!currentWorkout) return;
    const stats = completionStats(currentWorkout);
    if (stats.done === stats.total) {
      currentWorkout.activeInterval = null;
      return;
    }
    const intervals = workoutIntervals(currentWorkout);
    const active = intervals.find(interval => interval.key === currentWorkout.activeInterval?.key);
    if (!active || intervalIsComplete(currentWorkout, active)) startNextPendingInterval(active?.key || null);
  }

  function restartCurrentInterval() {
    if (!currentWorkout?.activeInterval) return;
    if (currentWorkout.pausedAt) {
      showToast("Resume the workout before restarting the timer.");
      return;
    }
    currentWorkout.activeInterval.startedAt = Date.now();
    currentWorkout.activeInterval.pausedMs = 0;
    currentWorkout.activeInterval.pausedAt = null;
    saveJson(KEYS.current, currentWorkout);
    renderWorkout();
    showToast("Current set timer restarted.");
  }

  function handleWorkoutChange(event) {
    const checkbox = event.target.closest("[data-set-id]");
    if (!checkbox || !currentWorkout) return;
    const set = findSet(currentWorkout, checkbox.dataset.setId);
    if (!set) return;
    if (checkbox.checked && set.amrap && !(Number(set.actualReps) > 0)) {
      checkbox.checked = false;
      const input = $(`[data-amrap-id="${cssEscape(set.id)}"]`);
      input?.focus();
      showToast("Enter the AMRAP reps before checking the set.");
      return;
    }
    set.completed = checkbox.checked;
    if (checkbox.checked) {
      set.completedAt = Date.now();
      const interval = currentWorkout.activeInterval;
      if (interval?.key === checkbox.dataset.intervalKey) {
        set.startedAt ||= interval.startedAt;
        set.durationSeconds = activeIntervalSeconds(interval, Date.now());
      }
    } else {
      set.completedAt = null;
      set.durationSeconds = null;
    }
    const activeKey = currentWorkout.activeInterval?.key;
    if (checkbox.checked && activeKey === checkbox.dataset.intervalKey) {
      const active = workoutIntervals(currentWorkout).find(interval => interval.key === activeKey);
      if (active && intervalIsComplete(currentWorkout, active)) startNextPendingInterval(activeKey);
    }
    persistWorkoutAndRefresh();
  }

  function handleWorkoutInput(event) {
    const input = event.target.closest("[data-amrap-id]");
    if (!input || !currentWorkout) return;
    const set = findSet(currentWorkout, input.dataset.amrapId);
    if (!set) return;
    set.actualReps = input.value === "" ? null : Number(input.value);
    saveJson(KEYS.current, currentWorkout);
  }

  function persistWorkoutAndRefresh() {
    saveJson(KEYS.current, currentWorkout);
    renderWorkout();
    renderHome();
  }

  function updateProgress() {
    const stats = currentWorkout ? completionStats(currentWorkout) : { done: 0, total: 0 };
    const percent = stats.total ? (stats.done / stats.total) * 100 : 0;
    $("#progress-bar").style.width = `${percent}%`;
    $("#progress-copy").textContent = `${stats.done} of ${stats.total} sets complete`;
    $("#finish-workout").disabled = !currentWorkout || stats.done !== stats.total;
  }

  function completionStats(workout) {
    const sets = allSets(workout);
    return { done: sets.filter(set => set.completed).length, total: sets.length };
  }

  function allSets(workout) {
    return workout.sections.flatMap(section => sectionSets(section));
  }

  function sectionSets(section) {
    if (section.kind === "exercise") return [...section.member.warmups, ...section.member.workSets];
    return section.members.flatMap(member => [...member.warmups, ...member.workSets]);
  }

  function findSet(workout, id) {
    return allSets(workout).find(set => set.id === id);
  }

  function togglePause() {
    if (!currentWorkout) return;
    if (currentWorkout.pausedAt) {
      currentWorkout.totalPausedMs += Date.now() - currentWorkout.pausedAt;
      currentWorkout.pausedAt = null;
      if (currentWorkout.activeInterval?.pausedAt) {
        currentWorkout.activeInterval.pausedMs += Date.now() - currentWorkout.activeInterval.pausedAt;
        currentWorkout.activeInterval.pausedAt = null;
      }
      showToast("Workout resumed.");
    } else {
      currentWorkout.pausedAt = Date.now();
      if (currentWorkout.activeInterval) currentWorkout.activeInterval.pausedAt = currentWorkout.pausedAt;
      showToast("Workout paused.");
    }
    saveJson(KEYS.current, currentWorkout);
    renderWorkout();
  }

  function updateTimers() {
    if (!currentWorkout) return;
    const now = Date.now();
    const elapsedMs = now - currentWorkout.startedAt;
    const currentPause = currentWorkout.pausedAt ? now - currentWorkout.pausedAt : 0;
    const activeMs = elapsedMs - currentWorkout.totalPausedMs - currentPause;
    $("#total-time").textContent = formatClock(Math.max(0, Math.floor(activeMs / 1000)));
    const interval = currentWorkout.activeInterval;
    const panel = $("#current-set-panel");
    if (!interval) {
      $("#current-set-time").textContent = completionStats(currentWorkout).done === completionStats(currentWorkout).total ? "Complete" : "—";
      panel.classList.remove("is-ready");
      return;
    }
    const seconds = activeIntervalSeconds(interval, now);
    $("#current-set-time").textContent = `${formatDuration(seconds)} / ${formatDuration(interval.targetSeconds)}`;
    panel.classList.toggle("is-ready", seconds >= interval.targetSeconds);
  }

  function activeIntervalSeconds(interval, now) {
    const currentPause = interval.pausedAt ? now - interval.pausedAt : 0;
    return Math.max(0, Math.floor((now - interval.startedAt - (interval.pausedMs || 0) - currentPause) / 1000));
  }

  function finishWorkout() {
    if (!currentWorkout || completionStats(currentWorkout).done !== completionStats(currentWorkout).total) return;
    const now = Date.now();
    const currentPause = currentWorkout.pausedAt ? now - currentWorkout.pausedAt : 0;
    currentWorkout.totalPausedMs += currentPause;
    currentWorkout.pausedAt = null;
    currentWorkout.finishedAt = now;
    currentWorkout.elapsedSeconds = Math.floor((now - currentWorkout.startedAt) / 1000);
    currentWorkout.activeSeconds = Math.floor((now - currentWorkout.startedAt - currentWorkout.totalPausedMs) / 1000);
    history.unshift(currentWorkout);
    saveJson(KEYS.history, history);
    currentWorkout = null;
    localStorage.removeItem(KEYS.current);
    renderAll();
    showView("history");
    showToast("Workout saved.");
  }

  function discardWorkout() {
    if (!currentWorkout || !confirm("Discard this unfinished workout?")) return;
    currentWorkout = null;
    localStorage.removeItem(KEYS.current);
    renderAll();
    showView("home");
  }

  function renderHistory() {
    const list = $("#history-list");
    if (!history.length) {
      list.innerHTML = `<div class="empty-state">Completed workouts will appear here.</div>`;
      return;
    }
    list.innerHTML = history.map(workout => {
      const amraps = allSets(workout).filter(set => set.amrap && set.actualReps != null);
      const amrapCopy = amraps.map(set => `${exerciseLabel(set.exercise)}: ${set.weight ?? "BW"} × ${set.actualReps}`).join(" · ");
      return `<article class="history-card">
        <div class="history-top">
          <div><p class="eyebrow">${escapeHtml(titleCase(workout.week))} week</p><h3>${escapeHtml(dayLabel(workout.day))}</h3></div>
          <time datetime="${new Date(workout.finishedAt).toISOString()}">${escapeHtml(formatDate(workout.finishedAt))}</time>
        </div>
        <div class="history-stats">
          <div class="history-stat"><span>Planned</span><strong>${formatDuration(workout.plannedSeconds)}</strong></div>
          <div class="history-stat"><span>Active</span><strong>${formatDuration(workout.activeSeconds)}</strong></div>
          <div class="history-stat"><span>Elapsed</span><strong>${formatDuration(workout.elapsedSeconds)}</strong></div>
        </div>
        ${amrapCopy ? `<p class="amrap-summary">${escapeHtml(amrapCopy)}</p>` : ""}
      </article>`;
    }).join("");
  }

  async function importProgramFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    $("#program-editor").value = await file.text();
    previewEditorValidation();
  }

  async function loadProgramUrl() {
    const url = $("#program-url").value.trim();
    if (!url) return updateProgramStatus("Enter an HTTPS URL.", true);
    if (!url.startsWith("https://")) return updateProgramStatus("The program URL must use HTTPS.", true);
    try {
      updateProgramStatus("Loading…");
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      parseAndValidate(text);
      $("#program-editor").value = text;
      localStorage.setItem(KEYS.sourceUrl, url);
      updateProgramStatus("Loaded and valid. Tap Validate and activate.", false, true);
    } catch (error) {
      updateProgramStatus(`Could not load that URL: ${error.message}. The host may not permit browser access.`, true);
    }
  }

  function previewEditorValidation() {
    try {
      const candidate = parseAndValidate($("#program-editor").value);
      const summary = `${candidate.app_defaults.day_order.length} days · ${Object.keys(candidate.prescriptions).length - 1} prescriptions`;
      updateProgramStatus(`Valid program: ${summary}. Tap Validate and activate.`, false, true);
    } catch (error) {
      updateProgramStatus(error.message, true);
    }
  }

  function activateEditorProgram() {
    try {
      const text = $("#program-editor").value;
      const candidate = parseAndValidate(text);
      programYaml = text;
      program = candidate;
      localStorage.setItem(KEYS.program, text);
      reconcileAppState();
      populateSelectors();
      renderAll();
      updateProgramStatus(currentWorkout ? "Program activated. The active workout keeps its original snapshot." : "Program activated.", false, true);
      showToast("Program activated.");
    } catch (error) {
      updateProgramStatus(error.message, true);
    }
  }

  async function resetBundledProgram() {
    if (!confirm("Replace the editor with the bundled program.yaml?")) return;
    try {
      $("#program-editor").value = await fetchBundledProgram();
      previewEditorValidation();
    } catch (error) {
      updateProgramStatus(error.message, true);
    }
  }

  function updateProgramStatus(message, isError = false, isValid = false) {
    const element = $("#validation-message");
    element.textContent = message;
    element.classList.toggle("is-error", isError);
    element.classList.toggle("is-valid", isValid);
    $("#program-badge").textContent = isError ? "Error" : "Valid";
  }

  function exportYaml() {
    downloadText("program.yaml", programYaml, "text/yaml");
  }

  function exportBackup() {
    const backup = {
      exportedAt: new Date().toISOString(),
      version: 1,
      programYaml,
      appState,
      currentWorkout,
      history
    };
    downloadText(`garage-531-backup-${dateStamp()}.json`, JSON.stringify(backup, null, 2), "application/json");
  }

  async function importBackup(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      if (!backup || typeof backup !== "object" || typeof backup.programYaml !== "string" || !Array.isArray(backup.history)) {
        throw new Error("That file is not a Garage 5/3/1 backup.");
      }
      const importedProgram = parseAndValidate(backup.programYaml);
      if (!confirm(`Import the program and ${backup.history.length} completed workout${backup.history.length === 1 ? "" : "s"}? Existing history will be kept.`)) return;

      const merged = new Map(history.map(workout => [workout.id, workout]));
      backup.history.forEach(workout => {
        if (workout?.id) merged.set(workout.id, workout);
      });
      history = [...merged.values()].sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
      programYaml = backup.programYaml;
      program = importedProgram;
      appState = backup.appState && typeof backup.appState === "object" ? backup.appState : initialAppState(program);
      reconcileAppState();

      localStorage.setItem(KEYS.program, programYaml);
      saveJson(KEYS.history, history);
      saveJson(KEYS.state, appState);
      $("#program-editor").value = programYaml;
      populateSelectors();
      renderAll();
      updateProgramStatus(`Backup imported: ${backup.history.length} workout${backup.history.length === 1 ? "" : "s"}.`, false, true);
      showToast("Backup imported.");
    } catch (error) {
      updateProgramStatus(`Could not import backup: ${error.message}`, true);
      showToast("Backup import failed.");
    } finally {
      event.target.value = "";
    }
  }

  function downloadText(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function showView(name) {
    $$(".view").forEach(view => view.classList.toggle("is-active", view.id === `view-${name}`));
    $$(".nav-button").forEach(button => button.classList.toggle("is-active", button.dataset.view === name));
    if (name === "workout") renderWorkout();
    if (name === "history") renderHistory();
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function updateConnectionStatus() {
    const status = $("#connection-status");
    const standalone = window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
    status.textContent = `${standalone ? "HOME APP" : "SAFARI"}${navigator.onLine ? "" : " · OFFLINE"}`;
  }

  function showFatalProgramError(error) {
    $("#home-program-status").textContent = "Error";
    $("#start-workout").disabled = true;
    updateProgramStatus(error.message, true);
    showView("program");
  }

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    const hadController = Boolean(navigator.serviceWorker.controller);
    try {
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (hadController) $("#update-banner").classList.remove("is-hidden");
      });
      await navigator.serviceWorker.register("service-worker.js");
    } catch (_) {
      // The app remains usable without offline caching.
    }
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(toastHandle);
    toastHandle = setTimeout(() => toast.classList.remove("is-visible"), 2400);
  }

  function readJson(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function makeId() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours) return `${hours}:${String(minutes).padStart(2, "0")}`;
    return `${minutes}:${String(secs).padStart(2, "0")}`;
  }

  function formatClock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  function phaseLabel(name) {
    return String(name || "").replaceAll("_", " ").replace("partials", "partial");
  }

  function formatDate(timestamp) {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(timestamp));
  }

  function dateStamp() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  function titleCase(value) {
    return String(value).replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, letter => letter.toUpperCase());
  }

  function dayLabel(day) {
    return titleCase(day.replace(/_day$/, ""));
  }

  function exerciseLabel(exercise) {
    return titleCase(exercise);
  }

  function prescriptionLabel(name) {
    if (name === "bbb") return "Boring But Big · 5 × 10";
    if (name === "5-3-1") return "5/3/1";
    return name.toUpperCase();
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
  }

  function cssEscape(value) {
    return globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }
})();
