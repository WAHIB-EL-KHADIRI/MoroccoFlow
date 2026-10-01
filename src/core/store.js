import {
  clearDatabase,
  enqueueMutation,
  pendingMutations,
  put,
  remove,
  removeMutation,
  replaceWorkspace,
  seedDatabase,
  snapshot,
} from "./database.js";
import { apiClient, apiEnabled, AuthRequiredError } from "./api.js";
import { stores } from "../data/demo.js";

const syncableStores = new Set([
  "clients",
  "deals",
  "projects",
  "tasks",
  "invoices",
  "expenses",
  "notifications",
]);

/**
 * Replay order for the outbox. createdAt has millisecond precision and the outbox is
 * keyed by a random UUID, so two writes in the same millisecond used to replay in
 * random order (an update could reach the server before its create). The sequence is
 * microsecond-scaled wall time, bumped by one on a tie, so it keeps increasing within
 * a page and stays above anything queued before a reload.
 */
let lastSequence = 0;
function nextSequence() {
  lastSequence = Math.max(Date.now() * 1000, lastSequence + 1);
  return lastSequence;
}

// Mutations queued before `sequence` existed fall back to their timestamp.
const replayOrder = (mutation) => mutation.sequence ?? Date.parse(mutation.createdAt) * 1000;

class AppStore extends EventTarget {
  #syncPromise = null;
  #state = {
    loading: true,
    error: null,
    needsAuth: false,
    syncing: false,
    syncError: null,
    user: null,
    mode: apiEnabled ? "company" : "demo",
    route: "dashboard",
    data: Object.fromEntries(stores.map((store) => [store, []])),
  };

  get state() {
    return this.#state;
  }

  async init() {
    try {
      if (!apiEnabled) {
        await seedDatabase();
        await this.reload();
        return;
      }
      try {
        await apiClient.refresh();
        await this.#pull();
      } catch (error) {
        if (error instanceof AuthRequiredError) {
          this.#set({ loading: false, needsAuth: true, error: null });
          return;
        }
        const cached = await snapshot();
        if (Object.values(cached).some((records) => records.length)) {
          this.#set({ data: cached, loading: false, error: null, syncError: error.message });
          return;
        }
        throw error;
      }
    } catch (error) {
      this.#set({ loading: false, error: error.message });
    }
  }

  async login(credentials) {
    this.#set({ loading: true, error: null });
    try {
      await apiClient.login(credentials);
      await this.#pull();
      this.#set({ needsAuth: false, loading: false, error: null });
    } catch (error) {
      this.#set({ loading: false, needsAuth: true, error: null });
      throw error;
    }
  }

  async logout() {
    if (apiEnabled) await apiClient.logout();
    await clearDatabase();
    this.#set({
      needsAuth: apiEnabled,
      user: null,
      data: Object.fromEntries(stores.map((store) => [store, []])),
    });
  }

  async reload() {
    const data = await snapshot();
    this.#set({ data, loading: false, error: null });
  }

  setRoute(route) {
    this.#set({ route });
  }

  async save(storeName, entity) {
    const now = new Date().toISOString();
    const record = {
      ...entity,
      id: entity.id || crypto.randomUUID(),
      updatedAt: now,
      createdAt: entity.createdAt || now,
    };
    await put(storeName, record);
    if (apiEnabled && syncableStores.has(storeName)) {
      await enqueueMutation({
        mutationId: crypto.randomUUID(),
        sequence: nextSequence(),
        storeName,
        action: "save",
        entity: record,
        createdAt: now,
      });
    }
    await this.reload();
    if (apiEnabled && navigator.onLine) await this.sync();
  }

  async delete(storeName, id) {
    const entity = this.#state.data[storeName]?.find((item) => item.id === id);
    await remove(storeName, id);
    if (apiEnabled && entity && syncableStores.has(storeName)) {
      await enqueueMutation({
        mutationId: crypto.randomUUID(),
        sequence: nextSequence(),
        storeName,
        action: "delete",
        entity,
        createdAt: new Date().toISOString(),
      });
    }
    await this.reload();
    if (apiEnabled && navigator.onLine) await this.sync();
  }

  async sync() {
    if (!apiEnabled || this.#state.needsAuth || !navigator.onLine) return;
    if (this.#syncPromise) return this.#syncPromise;
    this.#syncPromise = this.#runSync().finally(() => {
      this.#syncPromise = null;
    });
    return this.#syncPromise;
  }

  async #runSync() {
    this.#set({ syncing: true, syncError: null });
    try {
      const mutations = (await pendingMutations()).sort((a, b) => replayOrder(a) - replayOrder(b));
      for (const mutation of mutations) {
        await apiClient.pushMutation(mutation);
        await removeMutation(mutation.mutationId);
      }
      await this.#pull();
      this.#set({ syncing: false, syncError: null });
    } catch (error) {
      if (error instanceof AuthRequiredError) this.#set({ needsAuth: true });
      this.#set({ syncing: false, syncError: error.message });
    }
  }

  async #pull() {
    const workspace = await apiClient.pullWorkspace();
    await replaceWorkspace(workspace.data);
    const data = await snapshot();
    this.#set({
      data,
      user: workspace.user,
      needsAuth: false,
      loading: false,
      error: null,
      syncError: null,
    });
  }

  exportData() {
    return snapshot();
  }

  subscribe(callback) {
    const listener = () => callback(this.#state);
    this.addEventListener("change", listener);
    return () => this.removeEventListener("change", listener);
  }

  #set(patch) {
    this.#state = { ...this.#state, ...patch };
    this.dispatchEvent(new Event("change"));
  }
}

export const appStore = new AppStore();
