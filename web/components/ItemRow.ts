// One tracked item: unread bar, star, title (opening it marks the item seen), where it lives,
// its latest signal and when. Clicking the row opens its history and actions.
import { api, type ItemView } from "../api.ts";
import { absoluteTime, relativeTime } from "../time.ts";
import { computed, defineComponent, ref, type PropType } from "../vue.ts";
import { EventList } from "./EventList.ts";

const STATE_LABELS: Record<string, string> = { open: "", merged: "merged", closed: "closed", gone: "gone", manual: "" };

export const ItemRow = defineComponent({
  components: { EventList },
  props: { item: { type: Object as PropType<ItemView>, required: true } },
  emits: ["changed", "message"],
  setup(props, { emit }) {
    const open = ref(false);
    const editingNote = ref(false);
    const noteDraft = ref("");
    const busy = ref(false);

    const stateLabel = computed(() => {
      const i = props.item;
      const parts = [STATE_LABELS[i.itemState] ?? i.itemState, i.stateDetail ?? ""].filter((s) => s);
      return parts.join(", ");
    });
    // Only web links become clickable: a javascript: URL would run on this page, with the API's powers.
    const href = computed(() => (/^https?:\/\//i.test(props.item.url) ? props.item.url : undefined));
    // Hover text for the time column: which date it shows, and the others.
    const dates = computed(() => {
      const i = props.item;
      return [
        i.lastSignalAt ? `Latest news: ${absoluteTime(i.lastSignalAt)}` : "No news",
        i.updatedAt ? `Last updated: ${absoluteTime(i.updatedAt)}` : "",
        i.createdAt ? `Created: ${absoluteTime(i.createdAt)}` : "",
      ].filter((s) => s).join("\n");
    });
    const ci = computed(() => (props.item.ciState === "failure" ? "CI failing" : props.item.ciState === "pending" ? "CI running" : ""));

    async function markSeen() {
      if (!props.item.unread || props.item.kind === "manual") return;
      await api.seen(props.item.id);
      emit("changed", { ...props.item, unread: false });
    }
    async function change(c: Parameters<typeof api.change>[1], done: string) {
      busy.value = true;
      try {
        const r = await api.change(props.item.id, c);
        emit("changed", r.item);
        emit("message", r.warning ? `${done}, but not committed: ${r.warning}` : done);
      } catch (err) {
        emit("message", `Not saved: ${(err as Error).message}`);
      } finally {
        busy.value = false;
      }
    }
    function toggleStar() {
      const target = props.item.priority === "important" ? "normal" : "important";
      // Back to the default clears the setting, rather than pinning it in items.yaml.
      return change({ priority: target === props.item.defaultPriority ? null : target },
        target === "important" ? "Marked important" : "No longer important");
    }
    const toggleMute = () => change({ muted: !props.item.muted }, props.item.muted ? "Unmuted" : "Muted");
    function editNote() {
      noteDraft.value = props.item.note ?? "";
      editingNote.value = true;
    }
    async function saveNote() {
      await change({ note: noteDraft.value.trim() || null }, noteDraft.value.trim() ? "Note saved" : "Note removed");
      editingNote.value = false;
    }
    async function copyUrl() {
      await navigator.clipboard.writeText(props.item.url);
      emit("message", "Link copied");
    }
    function toggle() {
      open.value = !open.value;
      if (open.value) markSeen();
    }
    return {
      open, editingNote, noteDraft, busy, stateLabel, href, dates, ci, markSeen, toggleStar, toggleMute, editNote, saveNote, copyUrl, toggle,
      relativeTime, absoluteTime,
    };
  },
  template: `
    <li class="item" :class="{ 'item--unread': item.unread, 'item--muted': item.muted, 'item--open': open }">
      <div class="item__row" @click="toggle">
        <button class="star" type="button" :aria-pressed="item.priority === 'important'" :disabled="busy"
          :title="item.priority === 'important' ? 'Important: click to make it normal' : 'Mark important'"
          @click.stop="toggleStar">{{ item.priority === 'important' ? '★' : '☆' }}</button>
        <div class="item__main">
          <a class="item__title" :href="href" target="_blank" rel="noopener noreferrer" @click.stop="markSeen">{{ item.title }}</a>
          <div class="item__meta">
            <span class="item__where"><span class="item__instance">{{ item.instance ?? 'manual' }}</span> {{ item.repo }}</span>
            <span v-if="stateLabel" class="item__state" :class="'item__state--' + item.itemState">{{ stateLabel }}</span>
            <span v-if="ci" class="item__ci" :class="'item__ci--' + item.ciState">{{ ci }}</span>
            <span v-if="item.hasConflicts" class="item__ci item__ci--failure">conflicts</span>
            <span v-if="item.muted" class="item__state">muted</span>
          </div>
          <p v-if="item.lastSignalSummary" class="item__latest">{{ item.lastSignalSummary }}</p>
          <p v-if="item.note && !editingNote" class="item__note">{{ item.note }}</p>
        </div>
        <time v-if="item.lastSignalAt" class="item__time" :datetime="item.lastSignalAt" :title="dates">{{ relativeTime(item.lastSignalAt) }}</time>
        <time v-else-if="item.updatedAt" class="item__time item__time--quiet" :datetime="item.updatedAt" :title="dates">{{ relativeTime(item.updatedAt) }}</time>
      </div>
      <div v-if="open" class="item__panel">
        <div class="actions">
          <button type="button" :disabled="busy" @click="toggleMute">{{ item.muted ? 'Unmute' : 'Mute' }}</button>
          <button type="button" :disabled="busy" @click="editNote">{{ item.note ? 'Edit note' : 'Add note' }}</button>
          <button type="button" @click="copyUrl">Copy link</button>
        </div>
        <form v-if="editingNote" class="note-form" @submit.prevent="saveNote">
          <textarea v-model="noteDraft" rows="2" placeholder="Why you are watching this, what you are waiting for…" aria-label="Note"></textarea>
          <div class="actions">
            <button type="submit" class="primary" :disabled="busy">Save note</button>
            <button type="button" @click="editingNote = false">Cancel</button>
          </div>
        </form>
        <EventList v-if="item.kind !== 'manual'" :id="item.id" />
      </div>
    </li>`,
});
