// Each subscription and where it stands: what it follows, how far it has read and what is unseen.
// Read-only: acknowledging is the CLI's and the MCP's, so a page cannot lose anyone's news.
import type { SubscriptionStatus } from "../api.ts";
import { cursorText, orderSubscriptions, scopeText, unseenText } from "../view.ts";
import { computed, defineComponent, type PropType } from "../vue.ts";

// Only web links become clickable: a javascript: URL would run on this page, with the API's powers.
const webHref = (url: string) => (/^https?:\/\//i.test(url) ? url : undefined);

export const SubscriptionList = defineComponent({
  props: {
    subscriptions: { type: Array as PropType<SubscriptionStatus[]>, required: true },
    loaded: { type: Boolean, default: false },
    error: { type: String, default: "" },
    checkedAt: { type: String, default: "" },
  },
  setup(props) {
    const ordered = computed(() => orderSubscriptions(props.subscriptions));
    return { ordered, scopeText, cursorText, unseenText, webHref };
  },
  template: `
    <main class="list">
      <p v-if="error" class="error">Could not read the subscriptions: {{ error }}</p>
      <p v-else-if="!loaded" class="empty">Loading the subscriptions…</p>
      <p v-else-if="ordered.length === 0" class="empty">No subscriptions yet. A project starts one with <code>watcher subscribe</code> or <code>watcher track</code>.</p>
      <template v-else>
        <p class="subs__note">Read-only. A project acknowledges what it has read with <code>watcher ack</code> or the MCP <code>ack</code> tool.<span v-if="checkedAt"> Checked {{ checkedAt }}.</span></p>
        <ul class="subs">
          <li v-for="s in ordered" :key="s.name" class="sub" :class="{ 'sub--unseen': s.unseen > 0, 'sub--bad': s.error }">
            <div class="sub__head">
              <h2 class="sub__name">{{ s.name }}</h2>
              <span class="sub__state">{{ unseenText(s) }}</span>
            </div>
            <p class="sub__meta">
              <span>Register <code>{{ s.register }}</code></span>
              <span>{{ scopeText(s) }}</span>
              <span v-if="cursorText(s)">{{ cursorText(s) }}</span>
            </p>
            <ul v-if="s.items.length" class="sub__news">
              <li v-for="i in s.items" :key="i.url">
                <a v-if="webHref(i.url)" :href="webHref(i.url)" target="_blank" rel="noopener noreferrer">{{ i.title }}</a>
                <span v-else>{{ i.title }}</span>
                <span class="sub__count">{{ i.count }} {{ i.count === 1 ? 'update' : 'updates' }}</span>
              </li>
            </ul>
            <details v-if="s.scope !== 'all' && s.scope.length" class="sub__more">
              <summary>Followed items</summary>
              <ul><li v-for="u in s.scope" :key="u"><code>{{ u }}</code></li></ul>
            </details>
            <details v-if="s.exclude.length" class="sub__more">
              <summary>Left out</summary>
              <ul><li v-for="u in s.exclude" :key="u"><code>{{ u }}</code></li></ul>
            </details>
          </li>
        </ul>
      </template>
    </main>`,
});
