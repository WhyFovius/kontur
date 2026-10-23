
# UI Design and Motion Engineering

Before implementing or redesigning any frontend, inspect and apply the installed skills relevant to the task:

- `material-design-3-ui`: Material Design 3 / M3 Expressive tokens, components, layout, theming and accessibility.
- `frontend-design`: distinctive visual direction and production-grade UI implementation.
- `animations`: performant web animation design, interaction feedback and reduced-motion support.
- `web-design-guidelines`: final UX, accessibility and performance audit.
- GSAP skills: use only when complex timelines or scroll-driven choreography are justified.

## Design requirements

1. Follow Material Design 3 semantics. Do not interpret M3 as merely rounded cards and purple accents.
2. Establish a coherent design system before building individual screens.
3. Prefer meaningful state transitions and micro-interactions over decorative motion everywhere.
4. Use CSS for simple transitions. Use Motion for React when component or layout animation needs justify it. Use GSAP for complex timelines and scroll choreography.
5. Preserve the project's existing technology stack unless a change is justified.
6. Implement responsive layouts, keyboard accessibility, visible focus states and reduced-motion alternatives.
7. Animate transform and opacity whenever practical. Avoid animations that cause unnecessary layout recalculation.
8. Validate the actual application in a browser, inspect the finished UI, run available tests and fix visible defects.
9. Never claim a visual or accessibility audit passed unless it was actually performed.
10. Keep all existing business logic and API behavior intact during visual redesign.
