import { hashPassword } from "./server/auth"

const email = prompt("Enter email:")
const id = prompt("Enter user ID:")
const password = prompt("Enter password:")

if (id && password) {
  const hashedPassword = await hashPassword(password)
  console.log(`User ID: ${id}`)
  console.log(`Email: ${email}`)
  console.log(`Hashed Password: ${hashedPassword}`)
  console.log(`now date: ${Number(new Date())}`)
} else {
  console.error("User ID and password are required.")
}
