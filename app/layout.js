import './globals.css'
import FirebaseProvider from './firebase-provider'

export const metadata = {
  metadataBase: new URL('https://corinne-receptionist.com'),
  title: { default: 'Corinne AI Receptionist for Dental & Medical Offices', template: '%s | Corinne' },
  description: 'A HIPAA-ready AI virtual receptionist that answers calls, schedules appointments, follows up with patients, and connects to your dental or medical practice systems.',
  keywords: ['AI receptionist','dental virtual receptionist','medical answering service','dental appointment scheduling','healthcare AI voice agent','outbound patient calls'],
  alternates:{canonical:'/'},
  openGraph:{
    title:'Corinne — Every patient call, handled.',
    description:'24/7 AI phone coverage for modern dental and medical practices.',
    type:'website',locale:'en_US',url:'/',siteName:'Corinne',
    images:[{
      url:'https://images.pexels.com/photos/4269203/pexels-photo-4269203.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=630&w=1200',
      width:1200,height:630,
      alt:'A friendly medical receptionist helping a patient at a modern clinic front desk',
    }],
  },
  twitter:{
    card:'summary_large_image',title:'Corinne AI Receptionist',
    description:'AI phone coverage built for patient care.',
    images:['https://images.pexels.com/photos/4269203/pexels-photo-4269203.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=630&w=1200'],
  },
  robots:{index:true,follow:true,googleBot:{index:true,follow:true,'max-image-preview':'large','max-snippet':-1}},
}
export default function RootLayout({children}){return <html lang="en"><body><FirebaseProvider>{children}</FirebaseProvider></body></html>}
