// TYPESCRIPT PONG GAME
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var COLOURS = {
    units: "white",
    background: "orange"
};
var Unit = /** @class */ (function () {
    function Unit(x, y, h, w) {
        this.xS = 0;
        this.yS = 0;
        this.x = x;
        this.y = y;
        this.height = h;
        this.width = w;
    }
    //Method som ritar en rektangel med cordinaterna
    Unit.prototype.drawRec = function (context) {
        context.fillStyle = COLOURS.units;
        context.fillRect(this.x, this.y, this.width, this.height);
    };
    return Unit;
}());
var Paddle = /** @class */ (function (_super) {
    __extends(Paddle, _super);
    function Paddle(x, y, w, h) {
        return _super.call(this, x, y, h, w) || this;
    }
    Paddle.prototype.move = function (canvas) {
        if (Game.keyUp && this.y >= 0) {
            this.y -= 10;
        }
        if (Game.keyDown && this.y + this.height <= canvas.height) {
            this.y += 10;
        }
    };
    return Paddle;
}(Unit));
var computerPaddle = /** @class */ (function (_super) {
    __extends(computerPaddle, _super);
    function computerPaddle(x, y, w, h) {
        return _super.call(this, x, y, h, w) || this;
    }
    computerPaddle.prototype.update = function (ball, canvas) {
        //computer chases the ball
        if (ball.xS < 0) {
            if (this.y + this.height / 2 < ball.y && this.y + this.height <= canvas.height) {
                this.y += 9;
            }
            if (this.y + this.height / 2 > ball.y && this.y >= 0) {
                this.y -= 9;
            }
        }
    };
    return computerPaddle;
}(Unit));
var Ball = /** @class */ (function (_super) {
    __extends(Ball, _super);
    function Ball(x, y, w, h) {
        var _this = _super.call(this, x, y, w, h) || this;
        _this.speed = 15;
        _this.xS = 10;
        _this.yS = 10;
        return _this;
    }
    Ball.prototype.drawBall = function (context, balldimensions) {
        context.beginPath();
        context.fillStyle = COLOURS.units;
        context.arc(balldimensions.x, balldimensions.y, balldimensions.width, 0, Math.PI * 2, false);
        context.fill();
    };
    Ball.prototype.update = function (p1, p2, canvas) {
        this.x = this.x - this.xS;
        this.y = this.y - this.yS;
        //Canvas bottom collision
        if (this.y + this.width >= canvas.height) {
            this.yS = -this.yS;
            //Canvas Top collision
        }
        else if (this.y - this.width <= 0) {
            this.yS = -this.yS;
        }
        //If p2 misses ball - reset ball
        if (this.x >= canvas.width) {
            this.x = canvas.width / 2;
            Game.p1Score += 1;
            this.speed = 15;
        }
        //If p1 misses ball - reset ball
        if (this.x <= 0) {
            this.x = canvas.width / 2;
            Game.p2Score += 1;
            this.speed = 15;
        }
        //PLayer 1 Collision
        if (this.x - this.width <= p1.x + p1.width) {
            if (this.y + this.height >= p1.y && this.y <= p1.y + p1.height) {
                var collidePoint = (this.y - (p1.y + p1.height / 2));
                collidePoint = collidePoint / (p1.height / 2);
                var radianAngle = (Math.PI / 4) * collidePoint;
                this.xS = -this.speed * Math.cos(radianAngle);
                this.yS = -this.speed * Math.sin(radianAngle);
                this.speed += 0.5;
            }
        }
        //Player 2 Collision
        if (this.x + this.width >= p2.x) {
            if (this.y + this.height >= p2.y && this.y <= p2.y + p2.height) {
                var collidePoint = (this.y - (p2.y + p2.height / 2));
                collidePoint = collidePoint / (p2.height / 2);
                var radianAngle = (Math.PI / 4) * collidePoint;
                this.xS = this.speed * Math.cos(radianAngle);
                this.yS = -this.speed * Math.sin(radianAngle);
                this.speed += 0.1;
            }
        }
    };
    return Ball;
}(Unit));
var Game = /** @class */ (function () {
    function Game() {
        this.margin = 50;
        //"Lyssnar" efter nedtryckta tangenter
        window.addEventListener('keydown', function (key) {
            if (key.keyCode === 87)
                Game.keyUp = true;
            if (key.keyCode === 83)
                Game.keyDown = true;
        });
        //"Lyssnar" efter uppsläppta tangenter
        window.addEventListener('keyup', function () {
            Game.keyUp = false;
            Game.keyDown = false;
        });
        this.canvas = document.getElementById("canvas");
        this.canvas.height = window.innerHeight - 150;
        this.canvas.width = window.innerWidth - 150;
        this.ctx = this.canvas.getContext("2d");
        this.ctx.font = 'bold 50px serif';
        //Variables for objects
        var padding = 10, paddleStartY = this.canvas.height / 2, paddleW = 20, paddleH = 150;
        var ballsize = 10;
        //Skapar Objects
        this.p1 = new Paddle(padding, paddleStartY, paddleW, paddleH);
        this.p2 = new computerPaddle(this.canvas.width - padding - paddleW, this.canvas.height / 2, paddleW, paddleH);
        this.ball = new Ball(this.canvas.width / 2, this.canvas.height / 2, ballsize, ballsize);
    }
    Game.prototype.drawGameTableDetails = function () {
        //Ritar sträcken i mitten av planen
        for (var i = 0; i < this.canvas.height; i += 30) {
            this.ctx.fillStyle = COLOURS.units;
            this.ctx.fillRect(this.canvas.width / 2, 0 + i, 5, 10);
        }
        //Ritar Score-Boarden
        this.ctx.fillText(Game.p1Score, this.canvas.width / 2 - this.margin - 20 /* texten är 50px */, 100);
        this.ctx.fillText(Game.p2Score, this.canvas.width / 2 + this.margin, 100);
    };
    //Uppdaterar alla objects position
    Game.prototype.update = function () {
        this.p2.update(this.ball, this.canvas);
        this.p1.move(this.canvas);
        this.ball.update(this.p1, this.p2, this.canvas);
    };
    //Ritar alla objects 
    Game.prototype.draw = function () {
        //draw court
        this.ctx.fillStyle = COLOURS.background;
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        this.p1.drawRec(this.ctx);
        this.p2.drawRec(this.ctx);
        this.ball.drawBall(this.ctx, this.ball);
        this.drawGameTableDetails();
    };
    /* Spel Loopen
    1. Uppdaterar alla positioner
    2. ritar ut allt
    3. startar om loopen igen
    */
    Game.prototype.gameLoop = function () {
        game.update();
        game.draw();
        requestAnimationFrame(game.gameLoop);
    };
    Game.keyUp = false;
    Game.keyDown = false;
    Game.p1Score = 0;
    Game.p2Score = 0;
    return Game;
}());
//Skapar ett spel
var game = new Game;
//startar loopen
function start() {
    requestAnimationFrame(game.gameLoop);
}
//# sourceMappingURL=pong.js.map