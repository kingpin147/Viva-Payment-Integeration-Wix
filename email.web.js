import { webMethod, Permissions } from 'wix-web-module';
import { contacts, triggeredEmails } from 'wix-crm-backend';

export const sendTicketEmail = webMethod(Permissions.Anyone, async (name, email, downloadUrl) => {
    try {
        console.log("🟨 Input received:", { name, email, downloadUrl });

        // ✅ Validate input
        if (!name || !email) {
            throw new Error("Missing required fields: name or email.");
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            throw new Error("Invalid email format.");
        }

        // 👤 Split name
        const [firstName, ...rest] = name.trim().split(" ");
        const lastName = rest.length > 0 ? rest.join(" ") : "";

        // 👥 Create contact
        const contactInfo = {
            name: { first: firstName, last: lastName },
            emails: [{ email, tag: "WORK", primary: true }]
        };

        const options = {
            allowDuplicates: true,
            suppressAuth: true
        };

        const contact = await contacts.createContact(contactInfo, options);
        const contactId = contact._id;

        if (!contactId) throw new Error("Failed to retrieve contact ID.");

        // 📤 Send triggered email
        const emailResult = await triggeredEmails.emailContact("Uxjv3Qw", contactId, {
            variables: {
                DOWNLOAD_URL: downloadUrl,
                SITE_URL: "https://www.live-ls.com/"
            } 
        });

        console.log("📧 Email sent successfully.");
        return { success: true, message: "Email sent successfully.", result: emailResult };

    } catch (error) {
        console.error("❌ Error in sendTicketEmail:", error);
        return { success: false, message: error.message || "Unable to send ticket email." };
    }
});