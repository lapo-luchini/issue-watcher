// Filters, adding an item, "Mark all seen", "Poll now" and how each forge's last poll went.
import { api, type Filters, type Status } from "../api.ts";
import { absoluteTime, relativeTime } from "../time.ts";
import { DEFAULT_REGISTER, type View } from "../view.ts";
import { computed, defineComponent, ref, type PropType } from "../vue.ts";

export const TopBar = defineComponent({
  props: {
    filters: { type: Object as PropType<Filters>, required: true },
    status: { type: Object as PropType<Status | null>, default: null },
    unreadCount: { type: Number, default: 0 },
    view: { type: String as PropType<View>, default: "items" },
    registers: { type: Array as PropType<string[]>, default: () => [] },
    register: { type: String, default: DEFAULT_REGISTER },
    subscriptionUnseen: { type: Number, default: 0 },
  },
  emits: ["update:filters", "update:register", "poll", "all-seen", "added", "message"],
  setup(props, { emit }) {
    const adding = ref(false);
    const url = ref("");
    const title = ref("");
    const saving = ref(false);
    const set = (key: keyof Filters, value: unknown) => emit("update:filters", { ...props.filters, [key]: value });
    const instances = computed(() => props.status?.instances ?? []);
    const failing = computed(() => instances.value.filter((i) => i.error || i.disabledReason));

    async function add() {
      saving.value = true;
      try {
        const r = await api.add(url.value.trim(), title.value.trim());
        emit("message", (r.manual ? "Added as a manual item" : "Added: it will be fetched on the next poll")
          + (r.warning ? `, but not committed: ${r.warning}` : ""));
        url.value = "";
        title.value = "";
        adding.value = false;
        emit("added");
      } catch (err) {
        emit("message", `Not added: ${(err as Error).message}`);
      } finally {
        saving.value = false;
      }
    }
    function describe(i: Status["instances"][number]): string {
      if (i.disabledReason) return `${i.id}: disabled, ${i.disabledReason}`;
      if (i.error) return `${i.id}: last poll failed ${relativeTime(i.lastRunAt)}: ${i.error}`;
      return i.lastSuccessAt ? `${i.id}: polled ${relativeTime(i.lastSuccessAt)}` : `${i.id}: not polled yet`;
    }
    return { adding, url, title, saving, set, instances, failing, add, describe, absoluteTime };
  },
  template: `
    <header class="topbar">
      <div class="topbar__head">
        <h1 class="topbar__title">Watcher <span v-if="unreadCount" class="topbar__count">{{ unreadCount }} unread</span></h1>
        <div class="topbar__actions">
          <template v-if="view === 'items'">
            <button type="button" @click="adding = !adding" :aria-expanded="adding">Add item</button>
            <button type="button" :disabled="!unreadCount" @click="$emit('all-seen')">Mark all seen</button>
          </template>
          <button type="button" class="primary" :disabled="status?.polling" @click="$emit('poll')">
            {{ status?.polling ? 'Polling…' : 'Poll now' }}
          </button>
        </div>
      </div>
      <div class="views">
        <nav class="views__nav" aria-label="View">
          <a href="#items" :aria-current="view === 'items' ? 'page' : null">Items</a>
          <a href="#subscriptions" :aria-current="view === 'subscriptions' ? 'page' : null">Subscriptions<span v-if="subscriptionUnseen" class="views__count">{{ subscriptionUnseen }} unseen</span></a>
        </nav>
        <select v-if="view === 'items' && registers.length > 1" class="views__register" :value="register" aria-label="Register"
          @change="$emit('update:register', $event.target.value)">
          <option v-for="r in registers" :key="r" :value="r">{{ r }}</option>
        </select>
      </div>
      <form v-if="adding && view === 'items'" class="add-form" @submit.prevent="add">
        <input v-model="url" type="url" required placeholder="https://… issue, PR, bug or mailing-list post" aria-label="URL" autofocus>
        <input v-model="title" type="text" placeholder="Title (for pages that are not on a forge)" aria-label="Title">
        <button type="submit" class="primary" :disabled="saving || !url">Add</button>
      </form>
      <div v-if="view === 'items'" class="filters" role="group" aria-label="Filters">
        <label><input type="checkbox" :checked="filters.unread" @change="set('unread', $event.target.checked)"> Unread only</label>
        <label><input type="checkbox" :checked="filters.important" @change="set('important', $event.target.checked)"> Important only</label>
        <label><input type="checkbox" :checked="filters.muted" @change="set('muted', $event.target.checked)"> Show muted</label>
        <select :value="filters.instance" @change="set('instance', $event.target.value)" aria-label="Forge">
          <option value="">All forges</option>
          <option v-for="i in instances" :key="i.id" :value="i.id">{{ i.id }}</option>
        </select>
      </div>
      <ul class="instances">
        <li v-for="i in instances" :key="i.id" class="instance" :class="{ 'instance--bad': i.error || i.disabledReason }"
          :title="describe(i)">{{ i.id }}</li>
      </ul>
      <ul v-if="failing.length" class="problems">
        <li v-for="i in failing" :key="i.id">{{ describe(i) }}</li>
      </ul>
    </header>`,
});
