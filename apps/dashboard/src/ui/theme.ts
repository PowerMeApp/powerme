/**
 * Mantine theme for the PowerMe dashboard. The palette is the driver app's (apps/mobile app_theme.dart,
 * mirrored in styles/tokens.css): Rich Black page, Graphite cards (radius 20), inputs radius 14,
 * pills radius 30, teal accent, gold brand, danger / warning for alerts. Dark only.
 *
 * Each colour tuple carries the brand value at index 5 (primaryShade 5), so `color="danger"` on a
 * Badge or Alert is exactly the token the CSS uses.
 */
import {
  Alert,
  Badge,
  Button,
  Card,
  createTheme,
  Drawer,
  Input,
  Modal,
  NativeSelect,
  Paper,
  Table,
  type CSSVariablesResolver,
  type MantineColorsTuple,
} from '@mantine/core';

const teal: MantineColorsTuple = [
  '#e0fffa',
  '#b3fff3',
  '#80ffeb',
  '#4dfce2',
  '#1af0d3',
  '#00e0c2',
  '#00b39b',
  '#008674',
  '#005a4e',
  '#002d27',
];
const danger: MantineColorsTuple = [
  '#fff0f0',
  '#ffd6d6',
  '#ffb3b3',
  '#ff9090',
  '#ff7e7e',
  '#ff6b6b',
  '#e05555',
  '#b84444',
  '#8f3333',
  '#662222',
];
const warning: MantineColorsTuple = [
  '#fff8e6',
  '#ffefc2',
  '#ffe59c',
  '#ffda77',
  '#ffd166',
  '#ffc857',
  '#e0ad45',
  '#b88a33',
  '#8f6a24',
  '#664b16',
];
const gold: MantineColorsTuple = [
  '#fbf5e0',
  '#f3e6b5',
  '#ead688',
  '#e2c65c',
  '#dbbb48',
  '#d4af37',
  '#b8962b',
  '#937722',
  '#6e5919',
  '#4a3b10',
];
const slate: MantineColorsTuple = [
  '#f2f3f6',
  '#e1e3e9',
  '#c8ccd6',
  '#b5bac6',
  '#a9aebc',
  '#9ea4b3',
  '#7f8594',
  '#626775',
  '#454955',
  '#2b2f3a',
];
/** Mantine dark scheme: [0] text, [2] dimmed, [4] borders, [6] default surface, [7] page. */
const dark: MantineColorsTuple = [
  '#ffffff',
  '#d6d9e0',
  '#9ea4b3',
  '#6b7180',
  '#2b2f3a',
  '#1f2229',
  '#1b1d22',
  '#0a0a0a',
  '#070707',
  '#000000',
];

export const theme = createTheme({
  primaryColor: 'teal',
  primaryShade: 5,
  colors: { teal, danger, warning, gold, slate, dark },
  autoContrast: true,
  luminanceThreshold: 0.45,
  white: '#ffffff',
  black: '#0a0a0a',
  fontFamily:
    "'Inter Variable', 'Inter', 'Roboto', system-ui, -apple-system, 'Segoe UI', Arial, sans-serif",
  headings: {
    fontFamily:
      "'Inter Variable', 'Inter', 'Roboto', system-ui, -apple-system, 'Segoe UI', Arial, sans-serif",
    fontWeight: '700',
    sizes: {
      h1: { fontSize: '1.625rem', lineHeight: '1.2' },
      h2: { fontSize: '1.125rem', lineHeight: '1.3' },
      h3: { fontSize: '1rem', lineHeight: '1.35' },
    },
  },
  fontSizes: { xs: '0.75rem', sm: '0.875rem', md: '0.9375rem', lg: '1.0625rem', xl: '1.25rem' },
  radius: { xs: '8px', sm: '10px', md: '14px', lg: '20px', xl: '30px' },
  defaultRadius: 'md',
  focusRing: 'auto',
  cursorType: 'pointer',
  components: {
    Card: Card.extend({ defaultProps: { radius: 'lg', padding: 'lg', withBorder: true } }),
    Paper: Paper.extend({ defaultProps: { radius: 'lg' } }),
    Button: Button.extend({ defaultProps: { radius: 'md' } }),
    Badge: Badge.extend({
      defaultProps: { radius: 'xl', variant: 'light', size: 'md', tt: 'none' },
    }),
    Alert: Alert.extend({ defaultProps: { radius: 'md', variant: 'light' } }),
    Input: Input.extend({ defaultProps: { radius: 'md' } }),
    NativeSelect: NativeSelect.extend({ defaultProps: { radius: 'md' } }),
    Table: Table.extend({
      defaultProps: { highlightOnHover: true, verticalSpacing: 'sm', horizontalSpacing: 'md' },
    }),
    Modal: Modal.extend({
      defaultProps: {
        radius: 'lg',
        centered: true,
        overlayProps: { backgroundOpacity: 0.6, blur: 2 },
      },
    }),
    Drawer: Drawer.extend({
      defaultProps: { position: 'right', overlayProps: { backgroundOpacity: 0.6, blur: 2 } },
    }),
  },
});

/** Mantine surfaces read the PowerMe tokens, so the library and styles/*.css share one source. */
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {},
  dark: {
    '--mantine-color-body': 'var(--rich-black)',
    '--mantine-color-text': 'var(--text)',
    '--mantine-color-dimmed': 'var(--muted)',
    '--mantine-color-default': 'var(--graphite-2)',
    '--mantine-color-default-hover': 'var(--graphite-3)',
    '--mantine-color-default-border': 'var(--line)',
    '--mantine-color-error': 'var(--danger)',
    '--mantine-color-placeholder': 'var(--muted)',
    '--mantine-color-anchor': 'var(--teal)',
  },
});
