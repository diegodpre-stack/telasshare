import ReactDOM from 'react-dom/client'
import App, { GlobalActions } from './App.jsx'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')).render(<><App /><GlobalActions /></>)
