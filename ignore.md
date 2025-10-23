Short answer
Virtual scrolling (aka windowing) is a technique that renders only the subset (“window”) of list items that are visible (plus a small buffer) instead of rendering the entire dataset. That keeps the DOM small, reduces memory and layout work, and dramatically improves scroll performance for very large lists.
Why it’s useful

- Performance: fewer DOM nodes → less paint/layout/JS work.
- Memory: only the visible items consume memory.
- Smooth scrolling: reduces jank for very large lists (thousands+ items).

How it works (conceptually)

1. Measure or assume the height of each item.
2. Compute which item indices are visible based on the scroll position and container height (startIndex..endIndex).
3. Render only items in that index range.
4. Use top and bottom spacer elements (empty divs with appropriate heights) so the scrollbar still represents the full list height.
5. Update the window on scroll (often throttled or with requestAnimationFrame) and optionally cache item sizes.

Common approaches

- Fixed-height windowing: easiest — item height is known or constant. Use index math.
- Variable-height windowing: harder — you need to measure item heights (or estimate and refine), cache sizes, and possibly adjust scroll anchors when sizes change.
- DOM node recycling: reuse a small set of DOM nodes and update their contents as you scroll (more complex but even fewer DOM operations).

Tradeoffs / gotchas

- Accessibility: screen readers and keyboard navigation can need extra handling.
- Scroll jumps: when item heights change you must adjust scroll offset carefully.
- Complexity: variable heights, virtualization with dynamic content, or preserving focus adds complexity.
- SEO / printing: virtualized content not present in DOM may not be crawled or printed.

Libraries (depending on framework)

- React: react-window, react-virtualized
- Angular: @angular/cdk/scrolling (cdk-virtual-scroll-viewport)
- Vue: vue-virtual-scroller
- Plain JS/TS: many small implementations or build your own for simple cases

Minimal TypeScript example (fixed item height)
This demonstrates the core idea (assumes fixed itemHeight):

HTML:

<div id="viewport" style="height:400px;overflow:auto;position:relative;">
  <div id="topSpacer"></div>
  <div id="list"></div>
  <div id="bottomSpacer"></div>
</div>

TypeScript:
const container = document.getElementById('viewport')!;
const topSpacer = document.getElementById('topSpacer')!;
const list = document.getElementById('list')!;
const bottomSpacer = document.getElementById('bottomSpacer')!;

const itemCount = 100000;
const itemHeight = 30; // px
const viewportHeight = 400;
const buffer = 5; // extra items above/below

// set full scroll height so scrollbar matches full list
const totalHeight = itemCount \* itemHeight;
topSpacer.style.height = '0px';
bottomSpacer.style.height = (totalHeight) + 'px';

function renderWindow() {
const scrollTop = container.scrollTop;
const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - buffer);
const endIndex = Math.min(itemCount - 1, Math.ceil((scrollTop + viewportHeight) / itemHeight) + buffer);

// adjust spacers
const topHeight = startIndex _ itemHeight;
const bottomHeight = (itemCount - endIndex - 1) _ itemHeight;
topSpacer.style.height = topHeight + 'px';
bottomSpacer.style.height = bottomHeight + 'px';

// render visible items
list.innerHTML = ''; // for demo; in production reuse nodes
for (let i = startIndex; i <= endIndex; i++) {
const el = document.createElement('div');
el.style.height = itemHeight + 'px';
el.textContent = `Item ${i}`;
list.appendChild(el);
}
}

// throttle with requestAnimationFrame for smoothness
let ticking = false;
container.addEventListener('scroll', () => {
if (!ticking) {
requestAnimationFrame(() => {
renderWindow();
ticking = false;
});
ticking = true;
}
});

// initial render
renderWindow();

Tips

- Prefer existing, well-tested libraries if you use a framework.
- For variable heights, measure and cache heights using ResizeObserver or manual measurement.
- Use requestAnimationFrame or a small debounce on scroll handlers to avoid layout thrashing.
- Test keyboard navigation and screen-reader behavior; add ARIA where needed.

If you want, I can:

- Provide a full reusable virtual-scroll TS class/component for your framework (React/Angular/Vue/plain TS).
- Show how to handle variable-height items with height caching and scroll anchor maintenance.

Which framework or environment are you using?
