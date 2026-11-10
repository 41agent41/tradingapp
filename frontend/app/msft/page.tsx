import { redirect } from 'next/navigation';

/** The old MSFT page is now the live chart for any symbol (E-21). */
export default function MSFTPage() {
  redirect('/live?symbol=MSFT');
}
