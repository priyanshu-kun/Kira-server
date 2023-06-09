import emailService from "../services/email.service.js";
import hashOtpService from "../services/hash.service.js";
import otpService from "../services/otp.service.js";
import UserService from "../services/user.service.js";
import tokenService from "../services/token.service.js"
import projectService from "../services/project.service.js";
import getImageURL from "../services/image.service.js"
import bugsService from "../services/bugs.service.js";
import timelineService from "../services/timeline.service.js";
import crypto from "crypto"
import url from "url"
import UserDto from "../dto/user.dto.js";
const {  fetchDetails, deleteAllProjectsRelatedToUser, updateAllProjectWhereUserInvited } = projectService;
const { deleteAllBugsRelatedToUser } = bugsService
const { sendMail,sendMailForTroubleShooting } = emailService
const { hashOTP, hashPassword, comparePassword } = hashOtpService
const { verifyOtp, generateOTP } = otpService
const { createUser, findAllUsers, findUserByEmail, findUserByUsernameAndEmail, findUserById, findUserByUsername, update, deleteAccountFromDB } = UserService
const { generateTokens, removeRefreshToken, storeRefreshToken, verifyRefreshToken, deleteAllRefreshTokens, findRefreshTokenInDB, updateRefreshToken } = tokenService
const { createNewActivity } = timelineService;
import Jimp from "jimp"
import path, { dirname } from "path"
import { fileURLToPath } from 'url';
import forgetpasswordModel from "../model/forgetpassword.model.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename)
const cookieOptions = {
    maxAge: 1000 * 60 * 60 * 24 * 30,
    httpOnly: true,
    sameSite: 'lax',
    domain: '.netlify.app'
}

class AuthController {


    async sendOTP(req, res) {
        try {
            const { Email } = req.body;
            if (!Email) {
                // handle error
                return res.status(500).json({ reqStatus: false, data: "Please provide an Email." })
            }
            const otp = await generateOTP();
            console.log(otp)
            const ttl = 1000 * 60 * 50;
            const expire = Date.now() + ttl;
            const data = `${Email}.${otp}.${expire}`
            const hash = await hashOTP(data)
            await sendMail(Email,otp)
            return res.json({
                reqStatus: true, data: {
                    otp,
                    hash: `${hash}.${expire}`,
                    Email
                }
            })
        }
        catch (e) {
            return res.status(500).json({ reqStatus: false, data: "Failed to process request." })
        }
    }



    async verifyOTP(req, res) {
        const { otp, hash, Email } = req.body;
        if (!otp || !hash || !Email) {
            return res.status(400).json({ reqStatus: false, data: 'All fields are required.' });
        }

        const [hashedOtp, expires] = hash.split('.');
        if (Date.now() > +expires) {
            return res.status(400).json({ reqStatus: false, data: 'OTP expired.' });
        }

        const data = `${Email}.${otp}.${expires}`;
        const isValid = await verifyOtp(data, hashedOtp);
        if (!isValid) {
            return res.status(400).json({ reqStatus: false, data: 'Invalid OTP' });
        }
        try {
            const user = await findUserByEmail({ email: Email });

            if (!user) {
                await createUser({ email: Email, username: "null", fullName: "null", password: "null", avatar: "null", activated: false, isVarified: true });
            }
        } catch (err) {
            return res.status(500).json({ reqStatus: false, data: "Error while creating new user." });
        }
        return res.json({ reqStatus: true, data: "Otp verified." })

    }



    async createAccount(req, res) {
        const { Email, password, username, fullName, avatar } = req.body;
        const parsedUrl = url.parse(req.url, true);
        const queryParams = parsedUrl.query;
        if (!Email || !password || !username || !fullName || !avatar) {
            return res.status(400).json({ reqStatus: false, data: 'All fields are required.' });
        }
        try {
            const userByUsername = await findUserByUsername(username)
            if (userByUsername) {
                return res.status(400).json({ reqStatus: false, data: 'Username already exists.' });
            }
        }
        catch (e) {
            return res.status(500).json({ reqStatus: false, data: 'Internal server error.' });
        }
        let imagePath;
        try {
            const buffer = Buffer.from(avatar.replace(/^data:image\/(png|jpg|jpeg|gif);base64,/, ''), "base64")
            imagePath = `${Date.now()}-${Math.round(Math.random() * 1e9)}.png`
            const jimpResp = await Jimp.read(buffer)
            jimpResp
                .resize(150, Jimp.AUTO)
                .write(path.resolve(__dirname, `../storage/${imagePath}`))
        }
        catch (e) {
            return res.status(500).json({ reqStatus: false, data: "Error while creating new user." });
        }
        let user;
        try {
            user = await findUserByEmail({ email: Email });
            if (user && !user.isVarified) {
                return res.status(401).json({ reqStatus: false, data: "User is not verified." })
            }
            const hashedPassword = await hashPassword(password);
            user = await UserService.ActivateUser(Email, { username, fullName, password: hashedPassword, avatar: `${process.env.BASE_URL}/storage/${imagePath}`, activated: true });

        } catch (err) {
            return res.status(500).json({ reqStatus: false, data: "Error while creating new user." });
        }
        if (queryParams.data) {
            try {
                const queryParamsRes = queryParams.data.split("*");
                const projectId = queryParamsRes[1];
                const mail = queryParamsRes[0]
                const project = await fetchDetails(projectId)
                if (project.users.length >= 50) {
                    return res.writeHead(301, {
                        Location: `${process.env.FRONT_URL}/`
                    }).end();
                }
                const isUserAlreadyInProject = project.users.find(s => s === mail);
                if (!isUserAlreadyInProject) {
                    project.users.push(mail);
                    project.save()
                }
            }
            catch (e) {
                return res.status(500).json({ reqStatus: false, data: "Error while creating new user." });
            }
        }
        try {
            const payload = {
                activityType: "newUserCreated",
                activityId: user._id,
                avatar: user.avatar,
                activity: {
                    title: user.username,
                    body: "Joined the Kira."
                }
            }
            await createNewActivity(payload)
        }
        catch (e) {
            return res.status(500).json({ reqStatus: false, data: "Error while creating timeline." });
        }
        const userDto = new UserDto(user)
        return res.json({ reqStatus: true, data: userDto })
    }



    async loginUser(req, res) {
        const { emailAndUsername, password } = req.body;
        if (!emailAndUsername || !password) {
            return res.status(400).json({ reqStatus: false, data: 'All fields are required.' });
        }
        try {

            const user = await findUserByUsernameAndEmail(emailAndUsername);
            if (!user) {
                return res.status(401).json({ reqStatus: false, data: "username, email or password is incorrect." });
            }
            if (!user.activated) {
                return res.status(401).json({ reqStatus: false, data: "Please create account first." });
            }
            const isMatch = await comparePassword(user.password, password);
            if (!isMatch) {
                return res.status(401).json({ reqStatus: false, data: "username, email or password is incorrect." });
            }
            const { accessToken, refreshToken } = await generateTokens({
                _id: user._id,
            });

            try {

                await storeRefreshToken(refreshToken, user._id)

            }
            catch (e) {
                return res.status(500).json({ reqStatus: false, data: "Internal server error." });
            }



            res.cookie('refreshToken', refreshToken, cookieOptions);
            res.cookie('accessToken', accessToken, cookieOptions);
            const userDto = new UserDto(user);
            return res.json({ reqStatus: true, data: { userDto, auth: true } });

        }
        catch (e) {
            return res.status(500).json({ reqStatus: false, data: "Error while login." });
        }
    }
    async getUser(req, res) {
        try {
            return res.json(req.user)
        }
        catch (e) {
            return res.status(500).json({ reqStatus: false, data: "Cannot get user." });
        }

    }

    async refresh(req, res) {
        const { refreshToken: refreshTokenFromCookie } = req.cookies;
        let userData;
        try {
            userData = await verifyRefreshToken(refreshTokenFromCookie)
        }
        catch (e) {
            return res.status(401).json({ reqStatus: false, data: "Invalid refresh token." });
        }
        try {
            const token = await findRefreshTokenInDB(
                userData._id,
                refreshTokenFromCookie
            );
            if (!token) {
                return res.status(401).json({ reqStatus: false, data: "Invalid refresh token." });
            }
        }
        catch (e) {
            return res.status(500).json({ reqStatus: false, data: "Internal error." });
        }

        let user;
        try {

            user = await findUserById(userData._id);
            if (!user) {
                return res.status(401).json({ reqStatus: false, data: "No user found." });
            }
        }
        catch (e) {
            return res.status(500).json({ reqStatus: false, data: "Internal error." });
        }

        const { refreshToken, accessToken } = await generateTokens({
            _id: user._id,
        });


        try {
            await updateRefreshToken(userData._id, refreshToken)
        }
        catch (e) {
            return res.status(500).json({ reqStatus: false, data: "Internal error." });
        }


        res.cookie('refreshToken', refreshToken, cookieOptions);
        res.cookie('accessToken', accessToken, cookieOptions);

        const userDto = new UserDto(user);
        return res.json({ reqStatus: true, data: { userDto, auth: true } });
    }
    async logOutUser(req, res) {
        const { refreshToken } = req.cookies;
        await removeRefreshToken(refreshToken)
        res.clearCookie('refreshToken')
        res.clearCookie('accessToken')
        return res.json({ reqStatus: true, data: { userDto: null, auth: false } });
    }
    async findUsers(req, res) {
        try {
            const users = await findAllUsers()
            const userDto = users.map(u => new UserDto(u));
            return res.json({ reqStatus: true, data: { userDto, auth: true } });
        }
        catch (e) {
            return res.status(500).json({ reqStatus: false, data: "Internal error." });
        }
    }
    async updateUser(req, res) {
        try {
            const { id } = req.params;
            const Payload = {
                ...req.body
            }
            const avatar = req.body.avatar;
            if (avatar !== "") {
                const imgPayloadAvatar = {
                    Attachment: {
                        img: avatar,
                        type: "avatar"
                    }
                }
                const result = await getImageURL(imgPayloadAvatar);
                Payload.avatar = result.img;
            }
            const Banner = req.body.Banner;
            if (Banner !== "") {
                const imgPayloadBanner = {
                    Attachment: {
                        img: Banner,
                    }
                }
                const result = await getImageURL(imgPayloadBanner);
                Payload.Banner = result.img;
            }
            const filteredPayload = Object.fromEntries(
                Object.entries(Payload).filter(([key, value]) => value !== '')
            );
            await update(id, filteredPayload)
            const user = await findUserById(id)

            try {
                const payload = {
                    activityType: "userUpdated",
                    activityId: user._id,
                    avatar: user.avatar,
                    activity: {
                        title: user.username,
                        body: "Update his/her profile."
                    }
                }
                await createNewActivity(payload)
            }
            catch (e) {
                return res.status(500).json({ reqStatus: false, data: "Error while creating timeline." });
            }
            const userDto = new UserDto(user);
            return res.json({ reqStatus: true, data: { userDto, auth: true } });
        }
        catch (e) {
            console.log(e)
            return res.status(500).json({ reqStatus: false, data: "Internal error." });
        }
    }

    async deleteAccount(req, res) {
        try {
            const { id } = req.params;
            await deleteAllBugsRelatedToUser(id)
            await deleteAllProjectsRelatedToUser(id)
            const user = await findUserById(id)
            try {
                const payload = {
                    activityType: "deleteAccount",
                    activityId: user._id,
                    avatar: user.avatar,
                    activity: {
                        title: user.username,
                        body: "Delete his/her Account."
                    }
                }
                await createNewActivity(payload)
            }
            catch (e) {
                return res.status(500).json({ reqStatus: false, data: "Error while creating timeline." });
            }
            const email = user.email
            await updateAllProjectWhereUserInvited(email)
            await deleteAccountFromDB(id)
            await deleteAllRefreshTokens(id)
            return res.json({ reqStatus: true, data: { userDto: {}, auth: false } });
        }
        catch (e) {
            return res.status(500).json({ reqStatus: false, data: "Internal error." });
        }
    }
    async showPassword(req, res) {
        try {
            const { id } = req.params;
            const user = await findUserById(id);
            if (comparePassword(req.body.pass, user.password)) {
                return res.json({ reqStatus: true, data: {} });
            }
            else {
                return res.json({ reqStatus: false, data: {} });
            }
        }
        catch (e) {
            return res.status(500).json({ reqStatus: false, data: "Internal error." });
        }
    }
    async troubleShootAccount(req,res) {
        try {
            const {emailAndUsername} = req.body;
            if(emailAndUsername === "Guest" || emailAndUsername === "zafyutikka@gufum.com") {
                return res.status(500).json({ reqStatus: false, data: "You cannot change guest user credentials." });
            }
            if(!emailAndUsername) {
                return res.status(404).json({ reqStatus: false, data: "All fields must be required." });
            }
            const user = await findUserByUsernameAndEmail(emailAndUsername);
            if (!user) {
                return res.status(401).json({ reqStatus: false, data: "username, email or password is incorrect." });
            }
            
            const resetPasswordToken = crypto.randomBytes(32).toString('hex');
            const ttl = 3600000;
            const resetPasswordExpires = Date.now()+ttl;

            const resp = await forgetpasswordModel.create({
                userId: user._id,
                token: resetPasswordToken,
                expired: resetPasswordExpires
            })

            if(!resp) {
                return res.status(500).json({ reqStatus: false, data: "Internal error." });
            }

            const payload = {
                username: user.username,
                email: user.email,
                id: resetPasswordToken, 

            }
            await sendMailForTroubleShooting(user.email,payload)
            return res.json({reqStatus: true,data: {}})
        }
        catch (e) {
            return res.status(500).json({ reqStatus: false, data: "Internal error." });
        }
    }
    async forgotPassword(req,res) {
        try {
            const {passwordState} = req.body;
            if(!passwordState.password || !passwordState.confirmPassword) {
                return res.status(500).json({ reqStatus: false, data: "request body cannot be empty." });
            }
            if(passwordState.password !== passwordState.confirmPassword) {
                return res.status(500).json({ reqStatus: false, data: "Confirm password is incorrect." });
            }

            const doc = await forgetpasswordModel.findOne({token: req.params.id})
            if(!doc) {
                return res.status(500).json({ reqStatus: false, data: "Internal error." });
            }
            if(Date.now() > +doc.expired) {
                return res.status(500).json({ reqStatus: false, data: "Endpoint is expired." });
            }
            const hashedPassword = await hashPassword(passwordState.password);
            await update(doc.userId,{password: hashedPassword})
            await forgetpasswordModel.deleteOne({_id: doc._id})
            return res.json({reqStatus: true,data: {}})
        }
        catch (e) {
            return res.status(500).json({ reqStatus: false, data: "Internal error." });
        }
    }
}


export default new AuthController()
