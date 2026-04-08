import React, { useState } from 'react';
import {
  IconSearch,
  IconWorld,
  IconPhoto,
  IconShoppingCart,
  IconNews,
  IconMovie,
  IconChevronDown,
  IconChevronUp,
  IconExternalLink,
  IconStar,
  IconStarFilled,
  IconClock,
  IconBuildingStore,
} from '@tabler/icons-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchPayload {
  query: string;
  search_info?: {
    total_results?: string | number;
    time_taken_displayed?: string;
    query_displayed?: string;
  };
  knowledge_graph?: KnowledgeGraph;
  answer_box?: AnswerBox;
  organic_results?: OrganicResult[];
  top_stories?: StoryItem[];
  images?: ImageResult[];
  shopping_results?: ShoppingResult[];
  news_results?: NewsResult[];
  video_results?: VideoResult[];
  related_questions?: RelatedQuestion[];
  related_searches?: { query: string }[];
}

interface KnowledgeGraph {
  title: string;
  type?: string;
  description?: string;
  image?: string;
  website?: string;
  source_name?: string;
  source_link?: string;
  profiles?: { name: string; link: string }[];
  facts?: Record<string, string | number>;
  [key: string]: any;
}

interface AnswerBox {
  type?: string;
  result?: string;
  answer?: string;
  snippet?: string;
  title?: string;
  link?: string;
  displayed_link?: string;
  stock?: string;
  price?: string | number;
  currency?: string;
  exchange?: string;
  price_movement?: {
    movement?: string;
    percentage?: number;
    value?: number;
    date?: string;
  };
  temperature?: string;
  weather?: string;
  location?: string;
}

interface OrganicResult {
  position?: number;
  title: string;
  link: string;
  displayed_link?: string;
  snippet?: string;
  date?: string;
  favicon?: string;
  thumbnail?: string;
}

interface StoryItem {
  title: string;
  link: string;
  source?: string;
  date?: string;
  thumbnail?: string;
}

interface ImageResult {
  title?: string;
  thumbnail: string;
  original?: string;
  source?: string;
  link?: string;
}

interface ShoppingResult {
  title: string;
  link?: string;
  product_link?: string;
  source?: string;
  price?: string;
  extracted_price?: number;
  old_price?: string;
  rating?: number;
  reviews?: number;
  thumbnail?: string;
  delivery?: string;
}

interface NewsResult {
  title: string;
  link: string;
  source?: string;
  date?: string;
  snippet?: string;
  thumbnail?: string;
  favicon?: string;
}

interface VideoResult {
  title: string;
  link: string;
  thumbnail?: string;
  duration?: string;
  date?: string;
  snippet?: string;
  displayed_link?: string;
}

interface RelatedQuestion {
  question: string;
  snippet?: string;
  title?: string;
  link?: string;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const FaviconImg: React.FC<{ src?: string; alt?: string }> = ({ src, alt }) => {
  const [error, setError] = useState(false);
  if (!src || error) {
    return <IconWorld className="w-4 h-4 text-gray-400 flex-shrink-0" />;
  }
  return (
    <img
      src={src}
      alt={alt || ''}
      className="w-4 h-4 rounded-sm flex-shrink-0"
      onError={() => setError(true)}
      loading="lazy"
    />
  );
};

const ThumbnailImg: React.FC<{
  src?: string;
  alt?: string;
  className?: string;
}> = ({ src, alt, className = '' }) => {
  const [error, setError] = useState(false);
  if (!src || error) return null;
  return (
    <img
      src={src}
      alt={alt || ''}
      className={`object-cover ${className}`}
      onError={() => setError(true)}
      loading="lazy"
    />
  );
};

const StarRating: React.FC<{ rating: number; reviews?: number }> = ({
  rating,
  reviews,
}) => {
  const stars = [];
  for (let i = 1; i <= 5; i++) {
    if (i <= Math.floor(rating)) {
      stars.push(
        <IconStarFilled key={i} className="w-3.5 h-3.5 text-amber-400" />,
      );
    } else if (i - 0.5 <= rating) {
      stars.push(
        <IconStarFilled
          key={i}
          className="w-3.5 h-3.5 text-amber-400 opacity-60"
        />,
      );
    } else {
      stars.push(
        <IconStar key={i} className="w-3.5 h-3.5 text-gray-300 dark:text-gray-600" />,
      );
    }
  }
  return (
    <span className="inline-flex items-center gap-0.5">
      {stars}
      {reviews != null && (
        <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">
          ({reviews.toLocaleString()})
        </span>
      )}
    </span>
  );
};

// ---------------------------------------------------------------------------
// Section: Answer Box
// ---------------------------------------------------------------------------

const AnswerBoxCard: React.FC<{ data: AnswerBox }> = ({ data }) => {
  const answer = data.result || data.answer || data.snippet;
  if (!answer && !data.stock) return null;

  return (
    <div className="rounded-lg border border-nvidia-green/30 bg-nvidia-green/5 dark:bg-nvidia-green/10 p-4 mb-4">
      {data.title && (
        <div className="text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">
          {data.title}
        </div>
      )}
      {data.stock && data.price != null ? (
        <div>
          <span className="text-2xl font-bold text-gray-900 dark:text-gray-50">
            {data.currency || '$'}
            {data.price}
          </span>
          {data.price_movement && (
            <span
              className={`ml-2 text-sm font-medium ${
                data.price_movement.movement === 'Up'
                  ? 'text-green-600'
                  : data.price_movement.movement === 'Down'
                    ? 'text-red-600'
                    : 'text-gray-600'
              }`}
            >
              {data.price_movement.movement === 'Up' ? '+' : data.price_movement.movement === 'Down' ? '-' : ''}
              {data.price_movement.percentage != null && `${data.price_movement.percentage}%`}
            </span>
          )}
          <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {data.stock}
            {data.exchange && ` (${data.exchange})`}
          </div>
        </div>
      ) : data.temperature ? (
        <div>
          <span className="text-3xl font-bold text-gray-900 dark:text-gray-50">
            {data.temperature}
          </span>
          {data.weather && (
            <span className="ml-2 text-lg text-gray-600 dark:text-gray-400">
              {data.weather}
            </span>
          )}
          {data.location && (
            <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {data.location}
            </div>
          )}
        </div>
      ) : (
        <div className="text-lg font-semibold text-gray-900 dark:text-gray-50">
          {answer}
        </div>
      )}
      {data.link && (
        <a
          href={data.link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-nvidia-green hover:underline mt-2"
        >
          {data.displayed_link || 'Source'}
          <IconExternalLink className="w-3 h-3" />
        </a>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Section: Knowledge Graph
// ---------------------------------------------------------------------------

const KnowledgeGraphCard: React.FC<{ data: KnowledgeGraph }> = ({ data }) => (
  <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/50 p-4 mb-4">
    <div className="flex gap-4">
      {data.image && (
        <ThumbnailImg
          src={data.image}
          alt={data.title}
          className="w-20 h-20 rounded-lg flex-shrink-0"
        />
      )}
      <div className="min-w-0 flex-1">
        <h3 className="text-lg font-bold text-gray-900 dark:text-gray-50 leading-tight">
          {data.title}
        </h3>
        {data.type && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {data.type}
          </span>
        )}
        {data.description && (
          <p className="text-sm text-gray-700 dark:text-gray-300 mt-2 leading-relaxed line-clamp-3">
            {data.description}
          </p>
        )}
      </div>
    </div>

    {/* Facts */}
    {data.facts && Object.keys(data.facts).length > 0 && (
      <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700 grid grid-cols-2 gap-x-4 gap-y-1">
        {Object.entries(data.facts).slice(0, 6).map(([k, v]) => (
          <div key={k} className="text-sm">
            <span className="text-gray-500 dark:text-gray-400">
              {k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}:{' '}
            </span>
            <span className="text-gray-900 dark:text-gray-100 font-medium">
              {String(v)}
            </span>
          </div>
        ))}
      </div>
    )}

    {/* Links */}
    <div className="mt-3 flex flex-wrap items-center gap-3">
      {data.website && (
        <a
          href={data.website}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-nvidia-green hover:underline"
        >
          <IconWorld className="w-3.5 h-3.5" />
          Website
        </a>
      )}
      {data.source_link && data.source_name && (
        <a
          href={data.source_link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:underline"
        >
          {data.source_name}
        </a>
      )}
      {data.profiles?.map((p) => (
        <a
          key={p.name}
          href={p.link}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-gray-500 dark:text-gray-400 hover:text-nvidia-green hover:underline"
        >
          {p.name}
        </a>
      ))}
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Section: Organic Results
// ---------------------------------------------------------------------------

const OrganicResultCard: React.FC<{ result: OrganicResult }> = ({
  result,
}) => (
  <div className="group py-3 first:pt-0">
    {/* URL line */}
    <div className="flex items-center gap-2 mb-0.5">
      <FaviconImg src={result.favicon} alt={result.displayed_link} />
      <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
        {result.displayed_link || new URL(result.link).hostname}
      </span>
    </div>
    {/* Title */}
    <a
      href={result.link}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[15px] font-medium text-blue-700 dark:text-blue-400 hover:underline leading-snug line-clamp-1"
    >
      {result.title}
    </a>
    {/* Snippet */}
    <div className="flex gap-3 mt-1">
      <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed line-clamp-2 flex-1">
        {result.date && (
          <span className="text-gray-500 dark:text-gray-400 mr-1">
            {result.date} &mdash;
          </span>
        )}
        {result.snippet}
      </p>
      {result.thumbnail && (
        <ThumbnailImg
          src={result.thumbnail}
          alt={result.title}
          className="w-16 h-16 rounded flex-shrink-0 hidden sm:block"
        />
      )}
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Section: Top Stories / News
// ---------------------------------------------------------------------------

const StoryCard: React.FC<{ item: StoryItem | NewsResult }> = ({ item }) => (
  <a
    href={item.link}
    target="_blank"
    rel="noopener noreferrer"
    className="flex-shrink-0 w-56 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden hover:border-nvidia-green/50 transition-colors group"
  >
    {item.thumbnail && (
      <ThumbnailImg
        src={item.thumbnail}
        alt={item.title}
        className="w-full h-28 bg-gray-100 dark:bg-gray-800"
      />
    )}
    <div className="p-2.5">
      <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1 mb-1">
        {item.source && <span className="font-medium">{item.source}</span>}
        {item.date && (
          <>
            <span className="text-gray-300 dark:text-gray-600">&middot;</span>
            <span>{item.date}</span>
          </>
        )}
      </div>
      <div className="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-2 leading-snug group-hover:text-nvidia-green transition-colors">
        {item.title}
      </div>
    </div>
  </a>
);

// ---------------------------------------------------------------------------
// Section: Images
// ---------------------------------------------------------------------------

const ImageGrid: React.FC<{ images: ImageResult[] }> = ({ images }) => (
  <div className="grid grid-cols-4 sm:grid-cols-4 gap-1.5">
    {images.map((img, i) => (
      <a
        key={i}
        href={img.link || img.original || img.thumbnail}
        target="_blank"
        rel="noopener noreferrer"
        className="relative rounded-md overflow-hidden aspect-square group"
      >
        <ThumbnailImg
          src={img.thumbnail}
          alt={img.title}
          className="w-full h-full bg-gray-100 dark:bg-gray-800 group-hover:scale-105 transition-transform"
        />
        {img.source && (
          <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/60 to-transparent p-1">
            <span className="text-[10px] text-white truncate block">
              {img.source}
            </span>
          </div>
        )}
      </a>
    ))}
  </div>
);

// ---------------------------------------------------------------------------
// Section: Shopping
// ---------------------------------------------------------------------------

const ShoppingCard: React.FC<{ item: ShoppingResult }> = ({ item }) => {
  const href = item.link || item.product_link;
  return (
    <a
      href={href || '#'}
      target="_blank"
      rel="noopener noreferrer"
      className="flex-shrink-0 w-44 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden hover:border-nvidia-green/50 transition-colors"
    >
      {item.thumbnail && (
        <div className="bg-white p-2 flex items-center justify-center h-32">
          <ThumbnailImg
            src={item.thumbnail}
            alt={item.title}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      )}
      <div className="p-2.5 bg-gray-50 dark:bg-gray-800/50">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-2 leading-snug">
          {item.title}
        </div>
        {item.price && (
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-base font-bold text-gray-900 dark:text-gray-50">
              {item.price}
            </span>
            {item.old_price && (
              <span className="text-xs text-gray-400 line-through">
                {item.old_price}
              </span>
            )}
          </div>
        )}
        {item.rating != null && (
          <div className="mt-1">
            <StarRating rating={item.rating} reviews={item.reviews} />
          </div>
        )}
        {item.source && (
          <div className="mt-1 flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
            <IconBuildingStore className="w-3 h-3" />
            {item.source}
          </div>
        )}
        {item.delivery && (
          <div className="text-xs text-green-600 dark:text-green-400 mt-0.5">
            {item.delivery}
          </div>
        )}
      </div>
    </a>
  );
};

// ---------------------------------------------------------------------------
// Section: Videos
// ---------------------------------------------------------------------------

const VideoCard: React.FC<{ item: VideoResult }> = ({ item }) => (
  <a
    href={item.link}
    target="_blank"
    rel="noopener noreferrer"
    className="flex gap-3 py-2 group"
  >
    <div className="relative flex-shrink-0 w-32 h-20 rounded-md overflow-hidden bg-gray-100 dark:bg-gray-800">
      {item.thumbnail && (
        <ThumbnailImg
          src={item.thumbnail}
          alt={item.title}
          className="w-full h-full"
        />
      )}
      {item.duration && (
        <span className="absolute bottom-1 right-1 bg-black/80 text-white text-[10px] font-medium px-1 py-0.5 rounded">
          {item.duration}
        </span>
      )}
    </div>
    <div className="min-w-0 flex-1">
      <div className="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-2 leading-snug group-hover:text-nvidia-green transition-colors">
        {item.title}
      </div>
      <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 flex items-center gap-1">
        {item.displayed_link && <span>{item.displayed_link}</span>}
        {item.date && (
          <>
            {item.displayed_link && <span>&middot;</span>}
            <span>{item.date}</span>
          </>
        )}
      </div>
    </div>
  </a>
);

// ---------------------------------------------------------------------------
// Section: Related Questions (People Also Ask)
// ---------------------------------------------------------------------------

const RelatedQuestionItem: React.FC<{ item: RelatedQuestion }> = ({
  item,
}) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-gray-100 dark:border-gray-700 last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-2.5 text-left text-sm font-medium text-gray-900 dark:text-gray-100 hover:text-nvidia-green transition-colors"
      >
        <span className="pr-2">{item.question}</span>
        {open ? (
          <IconChevronUp className="w-4 h-4 flex-shrink-0 text-gray-400" />
        ) : (
          <IconChevronDown className="w-4 h-4 flex-shrink-0 text-gray-400" />
        )}
      </button>
      {open && (
        <div className="pb-3 pl-2">
          {item.snippet && (
            <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
              {item.snippet}
            </p>
          )}
          {item.link && item.title && (
            <a
              href={item.link}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-nvidia-green hover:underline mt-1.5"
            >
              {item.title}
              <IconExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Section Header
// ---------------------------------------------------------------------------

const SectionHeader: React.FC<{
  icon: React.ReactNode;
  title: string;
}> = ({ icon, title }) => (
  <div className="flex items-center gap-2 mb-2.5 mt-4 first:mt-0">
    <span className="text-nvidia-green">{icon}</span>
    <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-50 uppercase tracking-wide">
      {title}
    </h4>
  </div>
);

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

interface SearchResultsProps {
  payload: SearchPayload;
}

const SearchResults: React.FC<SearchResultsProps> = ({ payload }) => {
  const hasContent =
    payload.answer_box ||
    payload.knowledge_graph ||
    (payload.organic_results && payload.organic_results.length > 0) ||
    (payload.top_stories && payload.top_stories.length > 0) ||
    (payload.images && payload.images.length > 0) ||
    (payload.shopping_results && payload.shopping_results.length > 0) ||
    (payload.news_results && payload.news_results.length > 0) ||
    (payload.video_results && payload.video_results.length > 0);

  if (!hasContent) return null;

  return (
    <div className="my-3 max-w-2xl">
      {/* Answer Box */}
      {payload.answer_box && <AnswerBoxCard data={payload.answer_box} />}

      {/* Knowledge Graph */}
      {payload.knowledge_graph && (
        <KnowledgeGraphCard data={payload.knowledge_graph} />
      )}

      {/* Top Stories */}
      {payload.top_stories && payload.top_stories.length > 0 && (
        <div>
          <SectionHeader icon={<IconNews className="w-4 h-4" />} title="Top Stories" />
          <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 scrollbar-hide">
            {payload.top_stories.map((s, i) => (
              <StoryCard key={i} item={s} />
            ))}
          </div>
        </div>
      )}

      {/* Organic Results */}
      {payload.organic_results && payload.organic_results.length > 0 && (
        <div>
          <SectionHeader icon={<IconSearch className="w-4 h-4" />} title="Web Results" />
          <div className="divide-y divide-gray-100 dark:divide-gray-700/50">
            {payload.organic_results.map((r, i) => (
              <OrganicResultCard key={i} result={r} />
            ))}
          </div>
        </div>
      )}

      {/* Images */}
      {payload.images && payload.images.length > 0 && (
        <div>
          <SectionHeader icon={<IconPhoto className="w-4 h-4" />} title="Images" />
          <ImageGrid images={payload.images} />
        </div>
      )}

      {/* News */}
      {payload.news_results && payload.news_results.length > 0 && (
        <div>
          <SectionHeader icon={<IconNews className="w-4 h-4" />} title="News" />
          <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 scrollbar-hide">
            {payload.news_results.map((n, i) => (
              <StoryCard key={i} item={n} />
            ))}
          </div>
        </div>
      )}

      {/* Shopping */}
      {payload.shopping_results && payload.shopping_results.length > 0 && (
        <div>
          <SectionHeader
            icon={<IconShoppingCart className="w-4 h-4" />}
            title="Shopping"
          />
          <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 scrollbar-hide">
            {payload.shopping_results.map((s, i) => (
              <ShoppingCard key={i} item={s} />
            ))}
          </div>
        </div>
      )}

      {/* Videos */}
      {payload.video_results && payload.video_results.length > 0 && (
        <div>
          <SectionHeader icon={<IconMovie className="w-4 h-4" />} title="Videos" />
          <div className="divide-y divide-gray-100 dark:divide-gray-700/50">
            {payload.video_results.map((v, i) => (
              <VideoCard key={i} item={v} />
            ))}
          </div>
        </div>
      )}

      {/* Related Questions */}
      {payload.related_questions && payload.related_questions.length > 0 && (
        <div className="mt-4">
          <SectionHeader
            icon={<IconClock className="w-4 h-4" />}
            title="People Also Ask"
          />
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/30 px-3">
            {payload.related_questions.map((q, i) => (
              <RelatedQuestionItem key={i} item={q} />
            ))}
          </div>
        </div>
      )}

      {/* Related Searches */}
      {payload.related_searches && payload.related_searches.length > 0 && (
        <div className="mt-4">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">
            Related searches
          </div>
          <div className="flex flex-wrap gap-2">
            {payload.related_searches.map((rs, i) => (
              <span
                key={i}
                className="inline-block text-xs bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 px-2.5 py-1.5 rounded-full border border-gray-200 dark:border-gray-700"
              >
                {rs.query}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default SearchResults;
