import type { AiSettings, AppSettings, Article, Feed, Folder, Rule } from "../shared/types.js";

export interface DemoData {
  articles: Article[];
  feeds: Feed[];
  folders: Folder[];
  rules: Rule[];
  settings: AppSettings;
  aiSettings: AiSettings;
}

export const DEMO_RELEASE_ARTICLE_ID = 17;

interface DemoArticleBase {
  id: number;
  feedId: number;
  title: string;
  author: string;
  summary: string;
  url?: string;
  imageUrl?: string;
  isRead?: boolean;
  isStarred?: boolean;
}

type DemoArticleSpec = DemoArticleBase &
  ({ hoursAgo: number; publishedAt?: never } | { hoursAgo?: never; publishedAt: string }) &
  (
    | { section: string; paragraphs: [string, string, string]; contentHtml?: never }
    | { section?: never; paragraphs?: never; contentHtml: string }
  );

interface DemoFeedSource {
  feedUrl: string;
  siteUrl: string;
}

interface DemoFeedOptions {
  folderId?: number;
  source?: DemoFeedSource;
}

const IMAGE_PARAMS = "auto=format&fit=crop&w=720&q=82";

function before(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1_000).toISOString();
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function createFeed(
  id: number,
  title: string,
  createdAt: string,
  options: DemoFeedOptions = {},
): Feed {
  const feedSlug = slug(title);
  return {
    id,
    folderId: options.folderId ?? null,
    title,
    feedUrl: options.source?.feedUrl ?? `https://example.com/${feedSlug}/feed.xml`,
    siteUrl: options.source?.siteUrl ?? `https://example.com/${feedSlug}`,
    sourceKind: id === 6 ? "web" : "published",
    healthStatus: "healthy",
    lastErrorKind: null,
    lastMatchCount: id === 6 ? 18 : null,
    createdAt,
    pollIntervalMinutes: 20,
    unreadCount: 0,
    totalCount: 0,
    paused: false,
    refreshing: false,
    lastPostAt: null,
    lastAttemptAt: createdAt,
    lastSuccessAt: createdAt,
    lastHttpStatus: 200,
    lastError: null,
    nextPollAt: null,
  };
}

function createArticle(spec: DemoArticleSpec, feed: Feed, now: Date): Article {
  const publishedAt =
    spec.publishedAt === undefined ? before(now, spec.hoursAgo) : spec.publishedAt;
  const contentHtml =
    spec.contentHtml ??
    [
      `<p>${spec.summary}</p>`,
      `<h2>${spec.section}</h2>`,
      ...spec.paragraphs.map((paragraph) => `<p>${paragraph}</p>`),
    ].join("");

  return {
    id: spec.id,
    feedId: feed.id,
    feedTitle: feed.title,
    feedSourceKind: feed.sourceKind,
    folderId: feed.folderId,
    title: spec.title,
    url: spec.url ?? null,
    author: spec.author,
    publishedAt,
    discoveredAt: publishedAt,
    summary: spec.summary,
    imageUrl: spec.imageUrl ?? null,
    media: null,
    feedContentHtml: contentHtml,
    contentHtml,
    contentSource: spec.contentHtml === undefined ? "article" : "feed",
    extractionStatus: "complete",
    extractionError: null,
    aiSummary:
      spec.id === 1
        ? {
            text: "A calmer reading habit comes from narrowing inputs, making progress visible, and letting completed items leave the queue.",
            promptId: null,
            provider: "openai",
            model: "demo",
            sourceKind: "full",
            generatedAt: new Date(Date.parse(publishedAt) + 6 * 60 * 1_000).toISOString(),
            usage: { inputTokens: null, outputTokens: null },
            grounding: null,
          }
        : null,
    isRead: spec.isRead ?? false,
    isStarred: spec.isStarred ?? false,
  };
}

export function createDemoData(now = new Date()): DemoData {
  const createdAt = before(now, 24 * 90);
  const folders: Folder[] = [
    {
      id: 5,
      parentId: null,
      name: "feedfold",
      position: 0,
      sortDirection: "newest",
      unreadCount: 0,
    },
    {
      id: 1,
      parentId: null,
      name: "Design",
      position: 1,
      sortDirection: "newest",
      unreadCount: 0,
    },
    {
      id: 2,
      parentId: 1,
      name: "Interfaces",
      position: 0,
      sortDirection: "newest",
      unreadCount: 0,
    },
    {
      id: 3,
      parentId: null,
      name: "Independent web",
      position: 2,
      sortDirection: "oldest",
      unreadCount: 0,
    },
    {
      id: 4,
      parentId: null,
      name: "Technology",
      position: 3,
      sortDirection: "newest",
      unreadCount: 0,
    },
  ];
  const feeds = [
    createFeed(8, "releases", createdAt, {
      folderId: 5,
      source: {
        feedUrl: "https://github.com/egornomic/feedfold/releases.atom",
        siteUrl: "https://github.com/egornomic/feedfold/releases",
      },
    }),
    createFeed(1, "Signal & Craft", createdAt, { folderId: 1 }),
    createFeed(2, "Field Notes", createdAt),
    createFeed(3, "Interface Notes", createdAt, { folderId: 2 }),
    createFeed(4, "Common Ground", createdAt, { folderId: 3 }),
    createFeed(5, "Systems Weekly", createdAt, { folderId: 4 }),
    createFeed(6, "Low-tech Dispatch", createdAt, { folderId: 4 }),
    createFeed(7, "Margins", createdAt, { folderId: 3 }),
  ];
  const feedsById = new Map(feeds.map((feed) => [feed.id, feed]));
  const articleSpecs: DemoArticleSpec[] = [
    {
      id: DEMO_RELEASE_ARTICLE_ID,
      feedId: 8,
      title: "feedfold 0.4.3",
      url: "https://github.com/egornomic/feedfold/releases/tag/v0.4.3",
      author: "egornomic",
      publishedAt: "2026-08-22T13:08:01.000Z",
      summary:
        "Read quoted Nitter posts in context, reopen saved-article links reliably, and move between feeds with less friction.",
      contentHtml: `<ul>
<li>Quoted Nitter posts now have a distinct treatment, with quoted videos kept in the right place.</li>
<li>Saved-article links now reopen the saved view reliably.</li>
<li>Choosing a feed or folder now starts with its unread articles.</li>
</ul>`,
      isStarred: true,
    },
    {
      id: 1,
      feedId: 1,
      title: "A calmer way to keep up with the web",
      author: "Mara Bell",
      hoursAgo: 2,
      summary:
        "The best reading system is not the one that captures everything. It is the one that makes returning feel light.",
      section: "Make the queue finite",
      paragraphs: [
        "A useful reader should turn an endless stream into a sequence of small decisions. You choose what deserves attention, finish it, and move forward without the interface asking for anything else.",
        "That changes the emotional weight of keeping up. Unread counts become orientation rather than pressure, and a quiet archive replaces the fear that something important has disappeared.",
        "The goal is not perfect coverage. It is a durable habit that leaves enough attention for the ideas you decided to read in the first place.",
      ],
      imageUrl: `https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?${IMAGE_PARAMS}`,
    },
    {
      id: 2,
      feedId: 2,
      title: "What small tools get right",
      author: "Jonas Reed",
      hoursAgo: 5,
      summary:
        "Focused software earns trust by doing one job clearly and keeping its machinery out of the way.",
      section: "A legible promise",
      paragraphs: [
        "Small tools can state their promise in a sentence. Their limits are visible, so people understand where the tool helps and where their own judgment begins.",
        "That clarity also improves craft. When a product is not trying to become a platform, details such as loading, focus, and keyboard flow can receive the time they deserve.",
        "Constraint is not a lack of ambition. It is a decision to make the important path unusually dependable.",
      ],
    },
    {
      id: 3,
      feedId: 3,
      title: "Designing for the moment after ‘done’",
      author: "Inez Park",
      hoursAgo: 9,
      summary:
        "Completion deserves its own design: a clear state change, a natural next step, and no unnecessary celebration.",
      section: "Let completion feel complete",
      paragraphs: [
        "Many interfaces spend all their energy on starting an action. The quieter opportunity appears after it succeeds, when a person needs to understand what changed and where to go next.",
        "A good completion state removes ambiguity without becoming a performance. The item settles into place, the next meaningful option is close, and focus lands somewhere sensible.",
        "These tiny transitions are where software begins to feel considerate rather than merely functional.",
      ],
      imageUrl: `https://images.unsplash.com/photo-1497366754035-f200968a6e72?${IMAGE_PARAMS}`,
    },
    {
      id: 4,
      feedId: 1,
      title: "The hidden value of a quiet default",
      author: "Mara Bell",
      hoursAgo: 15,
      summary:
        "Defaults shape behavior long after onboarding ends, so the least demanding option is often the most humane one.",
      section: "Defaults are repeated decisions",
      paragraphs: [
        "Every default saves a choice, but it also suggests a norm. A busy default teaches people to tolerate interruption; a quiet one leaves room for deliberate attention.",
        "The best defaults are not neutral. They are an editorial position about what the product should protect when the person has not yet expressed a preference.",
        "When that position is coherent, settings become refinements instead of repairs.",
      ],
    },
    {
      id: 5,
      feedId: 2,
      title: "A field guide to useful constraints",
      author: "Jonas Reed",
      hoursAgo: 22,
      summary:
        "The right limitation shortens debate, clarifies quality, and gives a team a surface it can actually polish.",
      section: "Choose the boundary on purpose",
      paragraphs: [
        "A constraint only helps when it protects the outcome. Arbitrary scarcity creates frustration; a deliberate boundary turns a vague ambition into a tractable piece of work.",
        "Good constraints are easy to explain. They connect directly to the person using the product and remain stable enough for the team to build judgment around them.",
        "Once the boundary is clear, quality becomes easier to see and easier to discuss.",
      ],
      imageUrl: `https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?${IMAGE_PARAMS}`,
    },
    {
      id: 6,
      feedId: 4,
      title: "Small networks, strong communities",
      author: "Nadia Okafor",
      hoursAgo: 30,
      summary:
        "Healthy online spaces grow from repeated encounters, recognizable neighbors, and norms people can understand.",
      section: "Familiarity creates context",
      paragraphs: [
        "A community becomes legible when the same people meet often enough to remember one another. That memory adds context which no ranking system can manufacture.",
        "Small networks also make stewardship visible. Decisions have names attached to them, norms can be discussed, and care is easier to notice than it is at platform scale.",
        "Growth still matters, but it works best when it strengthens the relationships already holding the space together.",
      ],
    },
    {
      id: 7,
      feedId: 6,
      title: "The repairable web is still possible",
      author: "Ari Sol",
      hoursAgo: 40,
      summary:
        "Websites can remain understandable, portable, and inexpensive when their essential path uses ordinary materials.",
      section: "Build from inspectable parts",
      paragraphs: [
        "Repair begins with comprehension. A site made from familiar layers can be inspected, moved, and changed without reconstructing a vanished toolchain.",
        "This does not require rejecting modern techniques. It means reserving complexity for the moments where it creates a benefit a person can actually feel.",
        "Ordinary HTML, resilient links, and modest assets remain a remarkably capable foundation.",
      ],
      imageUrl: `https://images.unsplash.com/photo-1518770660439-4636190af475?${IMAGE_PARAMS}`,
    },
    {
      id: 8,
      feedId: 7,
      title: "A reading list that can breathe",
      author: "Elena Voss",
      hoursAgo: 52,
      summary:
        "A good list leaves space between subjects, mixes tempos, and accepts that not every saved piece needs to be finished.",
      section: "Curate for rhythm",
      paragraphs: [
        "Reading lists often become inventories, but inventories are not invitations. A smaller sequence with contrasting lengths and moods makes it easier to begin.",
        "Removing an item can be as valuable as adding one. The list improves whenever it more accurately reflects the questions that still matter to you.",
        "A breathable queue is not empty; it simply has enough shape that the next choice feels obvious.",
      ],
    },
    {
      id: 9,
      feedId: 3,
      title: "Making software feel at home",
      author: "Inez Park",
      hoursAgo: 66,
      summary:
        "Native feeling comes from respecting a place’s habits, not from copying the decoration of its most famous apps.",
      section: "Belong to the environment",
      paragraphs: [
        "People bring years of learned behavior to every new tool. Familiar shortcuts, window rules, and text selection matter because they let that knowledge keep working.",
        "Visual character can remain distinct while interaction stays grounded in the environment. The result feels authored without demanding constant relearning.",
        "The deepest form of polish is often compatibility with expectations no one thinks to mention.",
      ],
      imageUrl: `https://images.unsplash.com/photo-1483058712412-4245e9b90334?${IMAGE_PARAMS}`,
    },
    {
      id: 10,
      feedId: 6,
      title: "Notes from a solar-powered server",
      author: "Ari Sol",
      hoursAgo: 82,
      summary:
        "Intermittent energy changes software architecture by making patience, caching, and graceful recovery first-class concerns.",
      section: "Design around availability",
      paragraphs: [
        "A server powered by the weather cannot pretend that every request will arrive during abundance. It stores work, communicates uncertainty, and resumes without drama.",
        "Those qualities are useful far beyond an off-grid machine. Systems become kinder when temporary absence is an expected state rather than an exceptional failure.",
        "Energy constraints expose assumptions, and the resulting architecture is often more resilient everywhere else.",
      ],
    },
    {
      id: 11,
      feedId: 5,
      title: "When local-first stops being a feature",
      author: "Samir Chen",
      hoursAgo: 104,
      summary:
        "Local-first design is most convincing when ownership and offline behavior are simply how the product works.",
      section: "Make ownership ordinary",
      paragraphs: [
        "People should not need to understand a synchronization architecture to benefit from immediate writes and data that remains available without a network.",
        "The architectural work is substantial, but the product language can stay simple: your changes are here, they are safe, and collaboration will catch up.",
        "A principle becomes mature when it disappears into dependable everyday behavior.",
      ],
      imageUrl: `https://images.unsplash.com/photo-1497366811353-6870744d04b2?${IMAGE_PARAMS}`,
    },
    {
      id: 12,
      feedId: 1,
      title: "The case for slower notifications",
      author: "Mara Bell",
      hoursAgo: 126,
      summary:
        "Bundling low-urgency updates into deliberate intervals protects attention without asking people to disconnect.",
      section: "Match delivery to urgency",
      paragraphs: [
        "Most updates are useful eventually and disruptive immediately. Treating every event as urgent transfers the cost of sorting from the system to the person.",
        "A slower channel can preserve awareness while creating fewer context switches. The product still communicates; it simply chooses a rhythm proportional to the consequence.",
        "Notification design is ultimately a promise about which interruptions are worth making.",
      ],
    },
    {
      id: 13,
      feedId: 3,
      title: "Beautiful tools explain themselves",
      author: "Inez Park",
      hoursAgo: 154,
      summary:
        "Clarity and beauty reinforce each other when hierarchy reveals what an interface can do and what just happened.",
      section: "Let form carry meaning",
      paragraphs: [
        "A coherent interface reduces the distance between seeing and understanding. Position, scale, and motion can explain relationships before a label has to.",
        "Decoration becomes valuable when it strengthens that explanation. Texture can separate surfaces, rhythm can reveal groups, and restraint can identify the primary action.",
        "The result is not merely attractive. It is easier to trust because its behavior feels visible.",
      ],
      imageUrl: `https://images.unsplash.com/photo-1518005020951-eccb494ad742?${IMAGE_PARAMS}`,
    },
    {
      id: 14,
      feedId: 4,
      title: "The communities behind durable software",
      author: "Nadia Okafor",
      hoursAgo: 180,
      summary:
        "Long-lived tools depend on patient maintainers, shared rituals, and users who know how to contribute more than requests.",
      section: "Maintenance is a social system",
      paragraphs: [
        "Software survives when knowledge has more than one home. Documentation helps, but so do recurring conversations and a culture where small acts of stewardship are welcomed.",
        "Users become part of that system when they can report clearly, support one another, and understand the tradeoffs maintainers are navigating.",
        "Durability is rarely a heroic act. It is the accumulation of ordinary care across many releases.",
      ],
    },
    {
      id: 15,
      feedId: 7,
      title: "A practical guide to digital gardens",
      author: "Elena Voss",
      hoursAgo: 220,
      summary:
        "A useful digital garden favors evolving notes, visible connections, and a publishing rhythm that does not require finality.",
      section: "Publish while ideas are alive",
      paragraphs: [
        "A garden makes room for incomplete thought. Notes can begin as questions, gather links, and change shape as understanding becomes more precise.",
        "Visible revision lowers the pressure of publication while increasing its usefulness. Readers can see how an idea developed and where uncertainty remains.",
        "The practice works because it replaces the performance of completion with the habit of tending.",
      ],
      isRead: true,
    },
    {
      id: 16,
      feedId: 5,
      title: "Measuring software by attention returned",
      author: "Samir Chen",
      hoursAgo: 260,
      summary:
        "Productivity software should be judged by the time and concentration it gives back, not the activity it can record.",
      section: "Measure the space left behind",
      paragraphs: [
        "Activity is easy to count, which makes it tempting as a proxy for value. But a tool can create more clicks while making the underlying work slower and harder to understand.",
        "A better measure asks whether people finish sooner, resume with less effort, and spend more of the day inside the work rather than administering it.",
        "The strongest productivity feature may be the one that makes the product itself needed less often.",
      ],
      isRead: true,
    },
  ];
  const articles = articleSpecs.map((spec) => {
    const feed = feedsById.get(spec.feedId);
    if (!feed) throw new Error(`Demo feed ${spec.feedId} is missing.`);
    return createArticle(spec, feed, now);
  });

  const settings: AppSettings = {
    pollIntervalMinutes: 20,
    duplicateArticleWindowDays: 7,
    singleKeyShortcuts: true,
    markReadOnScroll: false,
    showYouTubeDescriptions: true,
    translationLanguage: "French",
    summaryPrompt: "Summarize the article clearly and preserve its central argument.",
    translationPrompt: "Translate the article faithfully while preserving its structure.",
    customPrompts: [
      {
        id: "key-ideas",
        name: "Key ideas",
        prompt: "Extract the three most useful ideas and explain why each matters.",
      },
    ],
  };
  const aiSettings: AiSettings = {
    credentialStorageAvailable: true,
    providers: [
      {
        id: "openai",
        label: "OpenAI",
        configured: true,
        defaultModel: "demo",
        models: [{ id: "demo", label: "Demo model" }],
      },
      {
        id: "gemini",
        label: "Google Gemini",
        configured: false,
        defaultModel: "demo",
        models: [{ id: "demo", label: "Demo model" }],
      },
      {
        id: "anthropic",
        label: "Anthropic",
        configured: false,
        defaultModel: "demo",
        models: [{ id: "demo", label: "Demo model" }],
      },
    ],
    features: { articleSummary: { provider: "openai", model: "demo" } },
  };
  const rules: Rule[] = [
    {
      id: 1,
      name: "Hide sponsored posts",
      feedId: null,
      folderId: null,
      conditions: [{ field: "any", pattern: "sponsored" }],
      conditionOperator: "and",
      action: "hide",
      enabled: true,
      matchedCount: 24,
      createdAt: before(now, 24 * 45),
      updatedAt: before(now, 24 * 45),
    },
    {
      id: 2,
      name: "Archive routine release notes",
      feedId: null,
      folderId: null,
      conditions: [{ field: "title", pattern: "release notes" }],
      conditionOperator: "and",
      action: "mark_read",
      enabled: true,
      matchedCount: 11,
      createdAt: before(now, 24 * 20),
      updatedAt: before(now, 24 * 20),
    },
  ];

  return { articles, feeds, folders, rules, settings, aiSettings };
}
