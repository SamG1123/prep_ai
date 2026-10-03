import "./globals.css";
import "./studio-overrides.css";
import "katex/dist/katex.min.css";
import AuthSessionProvider from "../components/AuthSessionProvider";
export default function RootLayout({children}:{children:React.ReactNode}) {
  return <html lang="en"><body><AuthSessionProvider>{children}</AuthSessionProvider></body></html>;
}
