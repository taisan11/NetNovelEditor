/* @refresh reload */
import { render } from 'solid-js/web'
import './index.css'
import { initStorage } from './storage'
import App from './App.tsx'

initStorage()

const root = document.getElementById('root')

render(() => <App />, root!)
