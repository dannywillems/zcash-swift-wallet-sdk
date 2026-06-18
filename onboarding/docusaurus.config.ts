import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import { themes as prismThemes } from 'prism-react-renderer';

// The course pins every upstream source link to this commit so the embeds
// cannot drift as the code is refactored. See onboarding/discovery.md.
const UPSTREAM = 'https://github.com/zcash/zcash-swift-wallet-sdk';
const PIN = 'fe836893bc71fc3e6eb173f4fc191aa43c3760af';

// The site is published from the `onboarding` branch of this fork.
const FORK_OWNER = 'dannywillems';
const REPO = 'zcash-swift-wallet-sdk';

const config: Config = {
  title: 'ZcashLightClientKit Onboarding',
  tagline:
    'A code-anchored course for contributing to the Zcash Swift wallet SDK',
  favicon: 'img/favicon.svg',

  url: `https://${FORK_OWNER}.github.io`,
  baseUrl: `/${REPO}/`,

  organizationName: FORK_OWNER,
  projectName: REPO,

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',

  future: {
    v4: true,
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  markdown: {
    format: 'detect',
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  // KaTeX stylesheet. The version MUST match the `katex` npm version that
  // rehype-katex pulls in (0.16.47), otherwise the generated class names and
  // the loaded CSS drift and the MathML accessibility fallback bleeds into
  // the visible page.
  stylesheets: [
    {
      href: 'https://cdn.jsdelivr.net/npm/katex@0.16.47/dist/katex.min.css',
      type: 'text/css',
      integrity:
        'sha384-nH0MfJ44wi1dd7w6jinlyBgljjS8EJAh2JBoRad8a3VDw2K69vfaaqm4WnR+gXtA',
      crossorigin: 'anonymous',
    },
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          editUrl: `https://github.com/${FORK_OWNER}/${REPO}/tree/onboarding/onboarding/`,
          remarkPlugins: [require('remark-math')],
          rehypePlugins: [require('rehype-katex')],
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themes: [
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        indexBlog: false,
        indexPages: true,
        language: ['en'],
        highlightSearchTermsOnTargetPage: true,
      },
    ],
    'docusaurus-theme-github-codeblock',
  ],

  themeConfig: {
    codeblock: {
      showGithubLink: true,
      githubLinkLabel: 'View on GitHub',
      showRunmeLink: false,
    },
    announcementBar: {
      id: 'ai-generated-disclaimer',
      content:
        'This site is automatically generated using Claude Code. Errors may have been introduced. The code is the law, always refer to the source in the zcash/zcash-swift-wallet-sdk repository.',
      backgroundColor: '#fef3c7',
      textColor: '#78350f',
      isCloseable: false,
    },
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'ZcashLightClientKit Onboarding',
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'courseSidebar',
          position: 'left',
          label: 'Course',
        },
        {
          href: `https://github.com/${FORK_OWNER}/${REPO}/tree/onboarding`,
          label: 'Source (onboarding branch)',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'This course',
          items: [
            {
              label: 'Source (fork, onboarding branch)',
              href: `https://github.com/${FORK_OWNER}/${REPO}/tree/onboarding`,
            },
            {
              label: 'Upstream repository',
              href: UPSTREAM,
            },
          ],
        },
        {
          title: 'Authoritative references',
          items: [
            {
              label: 'Zcash Protocol Specification (PDF)',
              href: 'https://zips.z.cash/protocol/protocol.pdf',
            },
            {
              label: 'ZIPs (Zcash Improvement Proposals)',
              href: 'https://zips.z.cash/',
            },
            {
              label: 'librustzcash workspace',
              href: 'https://github.com/zcash/librustzcash',
            },
          ],
        },
      ],
      copyright:
        'Auto-generated onboarding course. Not authoritative. The code is the law.',
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: [
        'bash',
        'toml',
        'json',
        'yaml',
        'swift',
        'rust',
        'ruby',
        'protobuf',
      ],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
