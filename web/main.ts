// The watcher's single page: important items first, then everything else, most recent signal first.
import { api, type Filters, type ItemView, type Status } from "./api.ts";
import { ItemRow } from "./components/ItemRow.ts";
import { TopBar } from "./components/TopBar.ts";
import iconDark from "./favicon.svg";
import iconLit from "./favicon-lit.svg";
import { computed, createApp, defineComponent, onMounted, onUnmounted, ref, watch } from "./vue.ts";

const FILTERS_KEY = "watcher.filters";
const DEFAULT_FILTERS: Filters = { unread: false, important: false, muted: false, instance: "" };
const REFRESH_MS = 60_000;

/** Filters are remembered per browser; storage may be unavailable (private windows). */
function savedFilters(): Filters {
  try {
    return { ...DEFAULT_FILTERS, ...JSON.parse(localStorage.getItem(FILTERS_KEY) ?? "{}") };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

const App = defineComponent({
  components: { ItemRow, TopBar },
  setup() {
    const filters = ref<Filters>(savedFilters());
    const items = ref<ItemView[]>([]);
    const status = ref<Status | null>(null);
    const loaded = ref(false);
    const error = ref("");
    const message = ref("");
    let messageTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setInterval> | undefined;

    function say(text: string) {
      message.value = text;
      clearTimeout(messageTimer);
      messageTimer = setTimeout(() => (message.value = ""), 6000);
    }
    async function load() {
      try {
        items.value = (await api.items(filters.value)).items;
        error.value = "";
      } catch (err) {
        error.value = (err as Error).message;
      } finally {
        loaded.value = true;
      }
    }
    async function loadStatus() {
      try {
        status.value = await api.status();
      } catch {
        // The item list reports connection problems; the status line can stay as it was.
      }
    }
    async function poll() {
      try {
        await api.poll();
      } catch (err) {
        // Not started (e.g. cron's poll is running): there is no new result to report.
        say((err as Error).message === "a poll is already running" ? "A poll is already running" : `Poll not started: ${(err as Error).message}`);
        await loadStatus();
        return;
      }
      await loadStatus();
      // Follow the poll until it ends, then show what it found.
      while (status.value?.polling) {
        await new Promise((r) => setTimeout(r, 1500));
        await loadStatus();
      }
      const p = status.value?.lastPoll;
      if (p?.error) say(`Poll failed: ${p.error}`);
      else if (p?.results) {
        const found = p.results.reduce((n, r) => n + r.newSignals, 0);
        say(found ? `${found} new update${found === 1 ? "" : "s"}` : "Nothing new");
      }
      await load();
    }
    async function allSeen() {
      await api.allSeen();
      await load();
    }
    function replace(updated: ItemView) {
      // Muted while muted items are hidden: it leaves the list now, not at the next refresh.
      if (updated.muted && !filters.value.muted) items.value = items.value.filter((i) => i.id !== updated.id);
      else items.value = items.value.map((i) => (i.id === updated.id ? updated : i));
    }

    watch(filters, (f) => {
      try {
        localStorage.setItem(FILTERS_KEY, JSON.stringify(f));
      } catch {
        // Not remembered: fine.
      }
      load();
    }, { deep: true });
    function refresh() {
      load();
      loadStatus();
    }
    // Back to the tab: show the current state now, not at the next tick.
    function onVisible() {
      if (document.visibilityState === "visible") refresh();
    }
    onMounted(() => {
      refresh();
      // Hidden tabs refresh too, so the tab's icon and title tell about news while in the background.
      refreshTimer = setInterval(refresh, REFRESH_MS);
      document.addEventListener("visibilitychange", onVisible);
    });
    onUnmounted(() => {
      clearInterval(refreshTimer);
      document.removeEventListener("visibilitychange", onVisible);
    });

    const important = computed(() => items.value.filter((i) => i.priority === "important"));
    const rest = computed(() => items.value.filter((i) => i.priority !== "important"));
    const unreadCount = computed(() => items.value.filter((i) => i.unread).length);
    // The tab shows it too: the lighthouse shines while something is unread, and the title counts.
    watch(unreadCount, (n) => {
      const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (icon) icon.href = n > 0 ? iconLit : iconDark;
      document.title = n > 0 ? `(${n}) Watcher` : "Watcher";
    }, { immediate: true });
    const filtered = computed(() => filters.value.unread || filters.value.important || filters.value.instance !== "");
    return { filters, items, status, loaded, error, message, important, rest, unreadCount, filtered, load, poll, allSeen, replace, say };
  },
  template: `
    <TopBar v-model:filters="filters" :status="status" :unread-count="unreadCount"
      @poll="poll" @all-seen="allSeen" @added="load" @message="say" />
    <main class="list">
      <p v-if="error" class="error">The watcher server is not answering ({{ error }}). Is <code>watcher serve</code> still running?</p>
      <template v-else-if="loaded && items.length === 0">
        <p v-if="filtered" class="empty">Nothing matches these filters.</p>
        <p v-else class="empty">Nothing tracked yet. Run a poll, or add an item by its URL.</p>
      </template>
      <section v-if="important.length" aria-labelledby="h-important">
        <h2 id="h-important" class="list__heading">Important</h2>
        <ul class="items">
          <ItemRow v-for="i in important" :key="i.id" :item="i" @changed="replace" @message="say" />
        </ul>
      </section>
      <section v-if="rest.length" aria-labelledby="h-rest">
        <h2 id="h-rest" class="list__heading">{{ important.length ? 'Everything else' : 'Items' }}</h2>
        <ul class="items">
          <ItemRow v-for="i in rest" :key="i.id" :item="i" @changed="replace" @message="say" />
        </ul>
      </section>
    </main>
    <p class="toast" role="status" aria-live="polite" v-show="message">{{ message }}</p>`,
});

createApp(App).mount("#app");
