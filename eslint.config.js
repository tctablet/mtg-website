// Bewusst NUR das Motion-Gate, kein Style-Linting: Animationen/Transitions
// duerfen nirgendwo inline in JS definiert werden — alles kommt aus
// src/motion.css (Tokens + Klassen). Der PostToolUse-Hook laesst diese Regel
// nach jedem Edit laufen; Verstoss = Exit 2 = sofortiges Agent-Feedback.
export default [
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "AssignmentExpression[left.object.property.name='style'][left.property.name=/^(transition|animation)/]",
          message: 'MOTION-GATE: Keine Inline-Motion via el.style.* — Klasse aus src/motion.css nutzen (.no-anim, .anim-*).',
        },
        {
          selector: "CallExpression[callee.property.name='setProperty'][arguments.0.value=/^(transition|animation)/]",
          message: 'MOTION-GATE: Keine Inline-Motion via style.setProperty — Klasse aus src/motion.css nutzen.',
        },
      ],
    },
  },
]
