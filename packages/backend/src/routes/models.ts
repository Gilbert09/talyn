import { Router } from 'express';
import {
  bundledFleetModelCatalog,
  type ApiResponse,
  type FleetModelCatalog,
} from '@talyn/shared';
import { assertUser } from '../middleware/auth.js';
import { isWithdrawnModel, replacementFor } from '../services/selfHosted/withdrawnModels.js';

/**
 * The agent models the apps may offer, with each agent's default.
 *
 * The apps read the model list from here, not from their own build. So a new
 * model, a new default or a retired id needs only a backend deploy. The desktop
 * and mobile apps show the change without a new release.
 *
 * A model that this process saw the vendor withdraw (`withdrawnModels.ts`) is
 * left out and mapped to its replacement, so that the pickers stop offering a
 * model that fails every run. An agent's default stays in the list: it is the
 * replacement for every other withdrawn model of that agent.
 *
 * Mounted PRE-`ownerScope`, next to `/system`: the answer is the same for every
 * caller and reads no table.
 */
export function fleetModelCatalog(): FleetModelCatalog {
  const catalog = bundledFleetModelCatalog();
  const defaults = new Set(Object.values(catalog.defaults));
  const withdrawn = catalog.models.filter((model) => isWithdrawnModel(model.id) && !defaults.has(model.id));
  if (withdrawn.length === 0) return catalog;
  const replacements = new Map(withdrawn.map((model) => [model.id, replacementFor(model.id)]));
  // An older retired id can point at a model that is now withdrawn too.
  const retired = Object.fromEntries(
    Object.entries(catalog.retired).map(([id, target]) => [id, replacements.get(target) ?? target]),
  );
  return {
    ...catalog,
    models: catalog.models.filter((model) => !replacements.has(model.id)),
    retired: { ...retired, ...Object.fromEntries(replacements) },
  };
}

export function modelRoutes(): Router {
  const router = Router();

  router.get('/', (req, res) => {
    assertUser(req);
    res.json({ success: true, data: fleetModelCatalog() } as ApiResponse<FleetModelCatalog>);
  });

  return router;
}
