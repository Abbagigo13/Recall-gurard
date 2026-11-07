RecallGuard frontend update

Files to replace in your existing project:

src/App.tsx

src/index.css

Files intentionally unchanged:

design-tokens/tokens.css (generated design tokens; already contains light/dark palettes)

tailwind.config.js (existing semantic token configuration is retained)

package.json (no new dependencies are required)

Included in this update:

Persistent light/dark theme switcher using data-theme on the document root

Responsive collapsible mobile navigation

Initial dashboard skeleton state

Toast feedback for research, memory writes, and RPC requests

Minimum-length validation for research and memory forms

Accessible navigation roles, labels, live feedback, and focus-visible styles

Responsive table overflow, mobile spacing, and reduced-motion support

Important implementation note:
The current application is one large App component with seven tab panels. True route-level/component lazy loading requires extracting those panels into separate modules without changing their state/API contracts. That refactor is intentionally not faked in this patch; it should be done as a separate safe stage after this UI update is tested.

After replacing files, run:
npm run dev

Then check:

Theme toggle and persistence after refresh.

Mobile menu at narrow browser widths.

Initial skeleton then dashboard data.

Research form validation and submission.

Memory form validation and submission.

RPC parameter validation and read query.