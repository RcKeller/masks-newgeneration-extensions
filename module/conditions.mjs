/* global Hooks, game, foundry, ActiveEffect */

/**
 * status-fx.mjs
 * ----------------------------------------------------------------------------
 * This file manages the automatic synchronization of status effect icons
 * on tokens based on the Actor's condition data in their sheet.
 * It listens for actor updates and adds/removes ActiveEffects as needed
 * to match the state of the 'Afraid', 'Angry', 'Guilty', 'Hopeless',
 * and 'Insecure' conditions.
 */

// Use the same namespace as other module files
const NS = "masks-newgeneration-extensions";

/**
 * Defines the conditions we want to manage and their corresponding icons.
 * - 'key': The string we look for in the actor's data (e.g., "Afraid").
 * - 'id': A unique statusId we'll use to tag the ActiveEffect for tracking.
 * - 'name': The display name for the ActiveEffect.
 * - 'img': The path to the icon.
 */
const MANAGED_CONDITIONS = {
  "Afraid": {
    id: `${NS}-afraid`,
    name: "Afraid",
    img: "modules/masks-newgeneration-unofficial/images/gameicons/shadow-follower-%23ffffff-%233da7db.svg"
  },
  "Angry": {
    id: `${NS}-angry`,
    name: "Angry",
    img: "modules/masks-newgeneration-unofficial/images/gameicons/enrage-%23ffffff-%233da7db.svg"
  },
  "Guilty": {
    id: `${NS}-guilty`,
    name: "Guilty",
    img: "modules/masks-newgeneration-unofficial/images/gameicons/liar-%23ffffff-%233da7db.svg"
  },
  "Hopeless": {
    id: `${NS}-hopeless`,
    name: "Hopeless",
    img: "modules/masks-newgeneration-unofficial/images/gameicons/broken-bone-%23ffffff-%233da7db.svg"
  },
  "Insecure": {
    id: `${NS}-insecure`,
    name: "Insecure",
    img: "modules/masks-newgeneration-unofficial/images/gameicons/screaming-%23ffffff-%233da7db.svg"
  }
};

/**
 * Finds the state of a specific condition (like "Afraid") from the actor's data.
 * @param {Actor} actor - The actor document.
 * @param {string} conditionKey - The string to search for, e.g., "Afraid".
 * @returns {boolean} - True if the condition is active, false otherwise.
 */
const getConditionState = (actor, conditionKey) => {
  // This path is consistent for both 'character' and 'npc' types
  const conditions = foundry.utils.getProperty(actor, "system.attributes.conditions.options");
  if (!conditions || typeof conditions !== "object") {
    return false;
  }

  // Iterate over the values of the conditions object (e.g., '0', '1', ...)
  for (const conditionData of Object.values(conditions)) {
    // Check that the label exists and starts with our key
    // This handles both "Afraid" and "Afraid (-2 to engage)"
    if (conditionData?.label && String(conditionData.label).startsWith(conditionKey)) {
      return !!conditionData.value;
    }
  }
  return false;
};

/**
 * Synchronizes all managed status effects for a given actor based on their sheet data.
 * This function is designed to be efficient by performing batch create/delete operations.
 * @param {Actor} actor - The actor to synchronize.
 */
const syncConditionEffects = async (actor) => {
  // Ensure actor and effects collection are available
  if (!actor?.effects) return;

  const effectsToCreate = [];
  const effectsToDelete = [];

  // Get all *managed* status IDs.
  const managedEffectIds = new Set(Object.values(MANAGED_CONDITIONS).map(c => c.id));
  
  // Find effects on the actor that *we* manage.
  // We build a map of { statusId => effectId }
  const currentEffects = new Map();
  for (const effect of actor.effects) {
    // Use the statuses set to identify our managed effects
    for (const statusId of effect.statuses) {
      if (managedEffectIds.has(statusId)) {
        currentEffects.set(statusId, effect.id);
        break; // Assume one effect per statusId
      }
    }
  }
  
  // Compare sheet data state vs. active effect state
  for (const [key, config] of Object.entries(MANAGED_CONDITIONS)) {
    const isAfflicted = getConditionState(actor, key);
    const hasEffect = currentEffects.has(config.id);

    if (isAfflicted && !hasEffect) {
      // Sheet says YES, but no effect exists: ADD EFFECT
      effectsToCreate.push({
        name: config.name,
        img: config.img,
        statuses: [config.id], // Tag it with our unique statusId
        origin: actor.uuid,    // Good practice to link origin
        transfer: false        // Don't transfer to items, etc.
      });
    } else if (!isAfflicted && hasEffect) {
      // Sheet says NO, but effect exists: REMOVE EFFECT
      const effectId = currentEffects.get(config.id);
      if (effectId) {
        effectsToDelete.push(effectId);
      }
    }
  }

  // Perform batch operations for efficiency
  try {
    if (effectsToCreate.length > 0) {
      await ActiveEffect.create(effectsToCreate, { parent: actor, keepId: false });
    }
    if (effectsToDelete.length > 0) {
      // Use Set to ensure no duplicates, just in case
      const finalDeleteIds = [...new Set(effectsToDelete)];
      await actor.deleteEmbeddedDocuments("ActiveEffect", finalDeleteIds);
    }
  } catch (err) {
    console.error(`[${NS}] Error synchronizing condition effects for ${actor.name}:`, err);
  }
};

/**
 * Helper to check if the 'conditions' data path was part of an update.
 * @param {object} changes - The 'changes' object from updateActor.
 * @returns {boolean}
 */
const didConditionsChange = (changes) => {
  // This check is robust: it triggers if 'options' is changed directly
  // or if a nested property like 'options.0.value' is changed.
  return foundry.utils.hasProperty(changes, "system.attributes.conditions.options");
};

// Register the main hook once the game is ready.
Hooks.once("ready", () => {
  /**
   * Main hook for keeping actor sheets and token effects in sync.
   * This is the core of the functionality.
   */
  Hooks.on("updateActor", (actor, changes, options, userId) => {
    // Check if the data we care about (conditions) was part of the update.
    if (didConditionsChange(changes)) {
      // Fire and forget: run the sync but don't block the update
      // operation from completing. This keeps the UI snappy.
      syncConditionEffects(actor);
    }
  });

  // Optional: Run a one-time sync for all actors on load if you are the GM.
  // This is good for scalability as it only runs once per GM client load
  // and catches any actors who had conditions *before* this module was active.
  if (game.user.isGM) {
    console.log(`[${NS}] | Running one-time sync for condition icons.`);
    const syncTasks = [];
    for (const actor of game.actors) {
      syncTasks.push(syncConditionEffects(actor));
    }
    // Run all syncs in parallel and log when complete.
    Promise.allSettled(syncTasks).then(() => {
      console.log(`[${NS}] | One-time condition icon sync complete.`);
    });
  }
});