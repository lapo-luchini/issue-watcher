// The watcher's single page: important items first, then everything else, most recent signal first.
import { api, setRegister, type Filters, type ItemView, type Status, type SubscriptionStatus } from "./api.ts";
import { ItemRow } from "./components/ItemRow.ts";
import { SubscriptionList } from "./components/SubscriptionList.ts";
import { TopBar } from "./components/TopBar.ts";
import { clock, pickRegister, totalUnseen, viewFromHash } from "./view.ts";
import iconDark from "./favicon.svg";
import iconLit from "./favicon-lit.svg";
import { computed, createApp, defineComponent, onMounted, onUnmounted, ref, watch } from "./vue.ts";

const FILTERS_KEY = "watcher.filters";
const DEFAULT_FILTERS: Filters = { unread: false, important: false, muted: false, instance: "" };
const REGISTER_KEY = "watcher.register";
const REFRESH_MS = 60_000;

function savedRegister(): string | null {
  try {
    return localStorage.getItem(REGISTER_KEY);
  } catch {
    return null;
  }
}

/** Filters are remembered per browser; storage may be unavailable (private windows). */
function savedFilters(): Filters {
  try {
    return { ...DEFAULT_FILTERS, ...JSON.parse(localStorage.getItem(FILTERS_KEY) ?? "{}") };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

const App = defineComponent({
  components: { ItemRow, SubscriptionList, TopBar },
  setup() {
    const filters = ref<Filters>(savedFilters());
    const view = ref(viewFromHash(location.hash));
    const registers = ref<string[]>([]);
    const register = ref(pickRegister(savedRegister(), []));
    setRegister(register.value);
    const subscriptions = ref<SubscriptionStatus[]>([]);
    const subsLoaded = ref(false);
    const subsError = ref("");
    const checkedAt = ref("");
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
      const asked = register.value;
      try {
        const answer = (await api.items(filters.value)).items;
        if (asked !== register.value) return; // the register was switched meanwhile: this answer is for the old one
        items.value = answer;
        error.value = "";
      } catch (err) {
        if (asked !== register.value) return;
        error.value = (err as Error).message;
      } finally {
        if (asked === register.value) loaded.value = true;
      }
    }
    async function loadStatus() {
      try {
        status.value = await api.status();
      } catch {
        // The item list reports connection problems; the status line can stay as it was.
      }
    }
    async function loadRegisters() {
      try {
        registers.value = (await api.registers()).registers;
        // A register that was deleted meanwhile: back to default, not an error page.
        const kept = pickRegister(register.value, registers.value);
        if (kept !== register.value) register.value = kept;
      } catch {
        // The item list reports connection problems; the switcher can stay as it was.
      }
    }
    async function loadSubscriptions() {
      try {
        subscriptions.value = (await api.subscriptionStatus()).subscriptions;
        subsError.value = "";
        checkedAt.value = clock(new Date());
      } catch (err) {
        subsError.value = (err as Error).message;
      } finally {
        subsLoaded.value = true;
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
      await Promise.all([load(), loadSubscriptions()]);
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
    // The other register: its items now, and the choice remembered. The list shows a blank state meanwhile, not the old register's items.
    watch(register, (name) => {
      try {
        localStorage.setItem(REGISTER_KEY, name);
      } catch {
        // Not remembered: fine.
      }
      setRegister(name);
      items.value = [];
      loaded.value = false;
      load();
    }, { flush: "sync" });
    function refresh() {
      load();
      loadStatus();
      loadRegisters();
      loadSubscriptions();
    }
    const onHash = () => (view.value = viewFromHash(location.hash));
    // Back to the tab: show the current state now, not at the next tick.
    function onVisible() {
      if (document.visibilityState === "visible") refresh();
    }
    onMounted(() => {
      refresh();
      // Hidden tabs refresh too, so the tab's icon and title tell about news while in the background.
      refreshTimer = setInterval(refresh, REFRESH_MS);
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("hashchange", onHash);
    });
    onUnmounted(() => {
      clearInterval(refreshTimer);
      window.removeEventListener("hashchange", onHash);
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
    const subscriptionUnseen = computed(() => totalUnseen(subscriptions.value));
    return {
      filters, view, registers, register, items, status, loaded, error, message, important, rest, unreadCount, filtered, subscriptions, subsLoaded,
      subsError, checkedAt, subscriptionUnseen, load, poll, allSeen, replace, say,
    };
  },
  template: `
    <TopBar v-model:filters="filters" v-model:register="register" :status="status" :unread-count="unreadCount" :view="view"
      :registers="registers" :subscription-unseen="subscriptionUnseen" @poll="poll" @all-seen="allSeen" @added="load" @message="say" />
    <SubscriptionList v-if="view === 'subscriptions'" :subscriptions="subscriptions" :loaded="subsLoaded" :error="subsError" :checked-at="checkedAt" />
    <main v-else class="list">
      <p v-if="error" class="error">The watcher server is not answering ({{ error }}). Is <code>watcher serve</code> still running?</p>
      <template v-else-if="loaded && items.length === 0">
        <p v-if="filtered" class="empty">Nothing matches these filters.</p>
        <p v-else-if="register !== 'default'" class="empty">Nothing in the register <code>{{ register }}</code> yet. Add an item by its URL.</p>
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
