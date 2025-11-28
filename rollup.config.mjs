import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import copy from 'rollup-plugin-copy';

export default [
  {
    input: 'sidepanel/index.js',
    output: {
      dir: 'dist/sidepanel',
      format: 'iife',
    },
    onwarn: (warning, warn) => {
      // Suppress common warnings from dependencies
      if (warning.code === 'THIS_IS_UNDEFINED') return;
      if (warning.code === 'CIRCULAR_DEPENDENCY') {
        // Only suppress known safe circular dependencies from zod
        if (warning.message.includes('node_modules/zod')) return;
      }
      // Otherwise, use default warning behavior
      warn(warning);
    },
    plugins: [
      nodeResolve({
        jsnext: true,
        main: true,
        browser: true
      }),
      commonjs({
        transformMixedEsModules: true
      }),
      copy({
        targets: [
          {
            src: ['manifest.json', 'background.js', 'sidepanel', 'images'],
            dest: 'dist'
          }
        ]
      })
    ]
  }
];
