/*
 * Who "Ask …" lines name: the system owner, else a Super Admin, as the API reports it (/api/me "contact"). The app
 * shell provides it, so the wording follows whoever holds the role.
 */
import * as React from "react"

export type Contact = { name: string; role: string } | null

const ContactContext = React.createContext<Contact>(null)
export const ContactProvider = ContactContext.Provider

/** "Samantha (system owner)" or, with withRole false, "Samantha"; "the system owner" before anyone holds the role. */
export function contactPhrase(c: Contact, withRole = true): string {
  if (!c) return "the system owner"
  return withRole ? `${c.name} (${c.role})` : c.name
}

export function useContact(withRole = true): string {
  return contactPhrase(React.useContext(ContactContext), withRole)
}
