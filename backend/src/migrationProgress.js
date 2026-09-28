const progressById = new Map();

function startMigrationProgress(id, seed = {}) {
  const progress = {
    id,
    phase: "validating",
    totalItems: 0,
    completedItems: 0,
    successfulItems: 0,
    failedItems: 0,
    message: "Preparing migration validation...",
    items: [],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...seed,
  };
  progressById.set(id, progress);
  return progress;
}

function updateMigrationProgress(id, patch = {}) {
  const current = progressById.get(id) || { id };
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  progressById.set(id, next);
  return next;
}

function getMigrationProgress(id) {
  return progressById.get(id) || null;
}

module.exports = { getMigrationProgress, startMigrationProgress, updateMigrationProgress };
