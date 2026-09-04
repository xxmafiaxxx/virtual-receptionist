import AdminApp from './ui'
export const metadata={title:'Admin dashboard',robots:{index:false,follow:false}}
export default function Admin(){
  const envStatus = {
    openai: Boolean(process.env.OPENAI_API_KEY),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    google: Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY),
    elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY),
    modelProvider: process.env.AI_MODEL_PROVIDER || 'openai',
    localModelUrl: process.env.LOCAL_MODEL_URL || 'http://localhost:11434',
  }
  return <AdminApp envStatus={envStatus}/>
}
