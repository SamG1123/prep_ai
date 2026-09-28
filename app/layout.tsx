import "./globals.css";
import "./studio-overrides.css";
import "katex/dist/katex.min.css";
export default function RootLayout({children}:{children:React.ReactNode}) {
  return <html lang="en"><body>{children}</body></html>;
}
