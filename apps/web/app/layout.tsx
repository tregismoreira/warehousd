import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

export const metadata = { title: "warehousd — security console" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        {children}
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
