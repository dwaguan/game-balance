# balance: a 2D physics based game
## graphic
    - a rotation allowed bar with mass, center fixed, initialized horizontally
    - 2 balls with mass free to move on it
## mechanism
    - gravity enabled, the bar's move is physically dependent on the position of the two balls and their gravity applied on the bar and the inertia of the bar:
        - initially the bar is heavy and the rotation is slow
        - as time goes by, the bar become lighter and lighter, and thus easier to become imbalanced, as a force termination mechanism
    - 2 balls controlled by 2 players:
        - left/right arrow: can only control acceleration and speed must comply with the acceleration
        - 2 balls have identical acceleration value intially
    - collision:
        - if the two ball collide, speed will changed according to real physics collision rules
        - collision can be avoid if any of the players enabled "invisible": active skill with cool down
## rules
    - if one player drops off the bar, he/she/it lost, the other player win
## dev notes
    - carefully design value balance first
## future dev plans
    - random bonus skills appear on the bar and who ever first gets there gets the skill for a while:
        - mass increase
        - acceleration increase
        - shorter invisible skill CD
        - inelastic collision skill
    - every collision can change something, the higher speed one gets random strengthened from also above perspectives
## followups
    - acceleration fixed along the axis or on horizontal axis?
    - when bar is tilted, gravity exist for balls or not (better slightly applied)
    - functionalities:
        - resolved: playing on phone support
            - display optimization
            - tilt control
    - debug:
        - resolved: P1 auto moves to the higher bar if no actions (anti-physics)
## improvement ideas
    - make it 3D: plate instead of bar
    - in current version, two experienced players often end up 在中心慢慢对撞，速度起不来，等到bar倾斜以后靠边的也没有足够加速度上来，自然掉下去输了，趣味性不够：
        - enlarge map: longer bar, so that one can wait to tilt the bar to affect the other
        - when the bar is tilted, player often hard to climb due to the drag of gravity, how about increase the default a>g
        - to avoid two balls are too close and both have no/low velocity, detect if two are too close and still going towards each other, explode them away (like energy stored exploded)
        - add some small traps that can only pass through with large enough velocity
        
