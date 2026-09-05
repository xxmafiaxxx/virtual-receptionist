import KioskCheckIn from './kiosk-client'

export const metadata = {
  title: 'Patient Check-in',
  robots: { index: false, follow: false },
}

export default async function KioskPage({ params }) {
  const { token } = await params
  return <KioskCheckIn token={token} />
}
