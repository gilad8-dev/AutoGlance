AutoGlance - font assets
================================

Drop four WOFF2 files here, then reload the extension. The CSS uses
@font-face with these exact filenames. Everything still looks decent
without them (system fallbacks kick in), but the real typography is
the point.

Required files:

  1. SpaceGrotesk-Variable.woff2
     https://fonts.google.com/specimen/Space+Grotesk
     → Download family → zip contains SpaceGrotesk-VariableFont_wght.ttf
     → Convert once with https://everythingfonts.com/ttf-to-woff2
     → Rename to: SpaceGrotesk-Variable.woff2

  2. Inter-Variable.woff2
     https://fonts.google.com/specimen/Inter
     → Download family → zip contains Inter-VariableFont_opsz,wght.ttf
     → Convert to WOFF2 (see link above)
     → Rename to: Inter-Variable.woff2

  3. Inter-Italic-Variable.woff2
     (From the same Inter zip as above)
     → Grab Inter-Italic-VariableFont_opsz,wght.ttf
     → Convert to WOFF2
     → Rename to: Inter-Italic-Variable.woff2

  4. JetBrainsMono-Variable.woff2
     https://www.jetbrains.com/lp/mono/
     → Download → fonts/webfonts/JetBrainsMono[wght].woff2
     → Rename to: JetBrainsMono-Variable.woff2

Folder layout after you're done:

  extension/assets/fonts/
    README.txt                          (this file)
    SpaceGrotesk-Variable.woff2
    Inter-Variable.woff2
    Inter-Italic-Variable.woff2
    JetBrainsMono-Variable.woff2

Licensing note: all free for commercial use.
Space Grotesk - SIL Open Font License.
Inter - SIL Open Font License.
JetBrains Mono - SIL Open Font License.
