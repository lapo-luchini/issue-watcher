// The history of one item: signal events newest first; "Show filtered" adds the noise, greyed,
// with the reason the filter gave.
import { api, type EventView } from "../api.ts";
import { absoluteTime, relativeTime } from "../time.ts";
import { defineComponent, onMounted, ref, watch } from "../vue.ts";

export const EventList = defineComponent({
  props: { id: { type: String, required: true } },
  setup(props) {
    const events = ref<EventView[]>([]);
    const showFiltered = ref(false);
    const loading = ref(true);
    const error = ref("");
    async function load() {
      loading.value = true;
      try {
        events.value = (await api.events(props.id, showFiltered.value)).events;
        error.value = "";
      } catch (err) {
        error.value = (err as Error).message;
      } finally {
        loading.value = false;
      }
    }
    onMounted(load);
    watch(showFiltered, load);
    /** "noise:pattern:^\+1$" → "matches ^\+1$"; "low-priority:ci" → "CI on a normal item". */
    function why(reason: string): string {
      const [kind, ...rest] = reason.split(":");
      const what = rest.join(":");
      if (kind === "low-priority") return `${what} only counts on important items`;
      if (what.startsWith("pattern")) return `matches ${what.slice("pattern:".length)}`;
      return { own: "your own", bot: "a bot", emoji: "only emoji", short: "too short" }[what] ?? what.replaceAll("-", " ");
    }
    /** Whether the event's text is shown as a quote, under a short heading instead of in the summary. */
    const quoted = (e: EventView) => !!e.excerpt && (e.kind === "comment" || e.kind === "review");
    function heading(e: EventView): string {
      if (!quoted(e)) return e.summary;
      const who = e.actor ? `@${e.actor}` : "someone";
      if (e.kind === "comment") return `${who} commented`;
      const state = String(e.details?.state ?? "").replaceAll("_", " ");
      return state && state !== "commented" ? `${who} reviewed: ${state}` : `${who} reviewed`;
    }
    return { events, showFiltered, loading, error, why, quoted, heading, relativeTime, absoluteTime };
  },
  template: `
    <div class="history">
      <label class="history__toggle"><input type="checkbox" v-model="showFiltered"> Show filtered</label>
      <p v-if="error" class="error">Could not load the history: {{ error }}</p>
      <p v-else-if="!loading && events.length === 0" class="history__empty">
        {{ showFiltered ? "Nothing recorded yet." : "No activity worth showing. Show filtered to see everything." }}
      </p>
      <ol class="history__list">
        <li v-for="e in events" :key="e.key" class="event" :class="{ 'event--noise': !e.isSignal, 'event--baseline': e.isBaseline }">
          <time class="event__time" :datetime="e.at" :title="absoluteTime(e.at)">{{ relativeTime(e.at) }}</time>
          <div class="event__body">
            <span class="event__summary">{{ heading(e) }}</span>
            <span v-if="!e.isSignal" class="event__why">filtered: {{ why(e.reason) }}</span>
            <blockquote v-if="quoted(e)" class="event__excerpt">{{ e.excerpt }}</blockquote>
          </div>
        </li>
      </ol>
    </div>`,
});
